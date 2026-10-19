"""Resumable one-off B2B price sync. prepare -> collect -> submit -> status.

Only Amazon Business marketplaces in this EU account. Does not change ALL prices.
"""
import argparse
import csv
import gzip
import io
import json
import os
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import requests
from auth import get_access_token, get_base_url

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'business_price_sync_state.json'
MARKETS = {'ES': ('A1RKKUPIHCS9HS', 'EUR'), 'DE': ('A1PA6795UKMFR9', 'EUR'),
           'FR': ('A13V1IB3VIYZZH', 'EUR'), 'IT': ('APJ6JRA9NG5V4', 'EUR'),
           'GB': ('A1F83G8C2ARO7P', 'GBP')}

def api(method, path, **kwargs):
    for attempt in range(60):
        try:
            response = requests.request(method, get_base_url()+path,
                headers={'x-amz-access-token': get_access_token()}, timeout=60, **kwargs)
        except requests.RequestException as exc:
            if attempt % 3 == 0: print('Network retry:', exc, flush=True)
            time.sleep(min(30, 2 ** min(attempt, 5))); continue
        if response.status_code == 429:
            if attempt % 3 == 0:
                print('Amazon rate limit:', method, path, 'retry', attempt+1, flush=True)
            time.sleep(min(40, 2 ** attempt)); continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError('Rate limit retries exhausted')

def save(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2))

def document(path):
    doc = api('GET', path)
    response = requests.get(doc['url'], timeout=90); response.raise_for_status()
    raw = response.content
    if doc.get('compressionAlgorithm') == 'GZIP': raw = gzip.decompress(raw)
    try: return raw.decode('utf-8-sig')
    except UnicodeDecodeError: return raw.decode('cp1252')

def business(price):
    return (Decimal(str(price))*Decimal('0.95')).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)

def main(action):
    state = json.loads(STATE.read_text()) if STATE.exists() else {'created': datetime.now(timezone.utc).isoformat(), 'markets': {}}
    if action == 'prepare':
        participation = api('GET','/sellers/v1/marketplaceParticipations')['payload']
        enabled = {p['marketplace']['id'] for p in participation if p['participation']['isParticipating']}
        for country, (mid, currency) in MARKETS.items():
            if mid not in enabled or country in state['markets']: continue
            report = api('POST', '/reports/2021-06-30/reports', json={
                'reportType': 'GET_MERCHANT_LISTINGS_ALL_DATA', 'marketplaceIds': [mid]})
            state['markets'][country] = {'marketplace':mid,'currency':currency,**report}
            save(state); print(country, report, flush=True); time.sleep(2)
    elif action == 'collect':
        for country, market in state['markets'].items():
            if 'plan' in market: continue
            report = api('GET','/reports/2021-06-30/reports/'+market['reportId'])
            market['reportStatus'] = report['processingStatus']; save(state)
            if report['processingStatus'] != 'DONE':
                print(country, report['processingStatus'], flush=True); continue
            content = document('/reports/2021-06-30/documents/'+report['reportDocumentId'])
            rows = list(csv.DictReader(io.StringIO(content),delimiter='\t'))
            plan=[]; skipped=0; seen=set()
            for raw in rows:
                row={k.strip().lower():v for k,v in raw.items() if k}
                sku=row.get('seller-sku'); price=row.get('price','')
                if not sku or not price or Decimal(price)<=0:
                    skipped+=1; continue
                if sku in seen: raise ValueError('Duplicate SKU '+sku)
                seen.add(sku)
                plan.append({'sku':sku,'normal':price,'business':str(business(price)),
                    'previous_business':row.get('business price',row.get('business-price',''))})
            plan_path=ROOT/('business_price_plan_'+country+'.json')
            plan_path.write_text(json.dumps(plan,ensure_ascii=False,indent=2))
            market.update(plan=str(plan_path),count=len(plan),skipped=skipped,columns=list(rows[0]) if rows else [])
            save(state); print(country,'plan',len(plan),'skipped',skipped,'sample',plan[:2],flush=True)
    elif action == 'submit':
        for country, market in state['markets'].items():
            if 'plan' not in market: continue
            plan=json.loads(Path(market['plan']).read_text())
            for start in range(0,len(plan),10000):
                key=str(start); feeds=market.setdefault('feeds',{})
                if key in feeds: continue
                messages=[]
                for i,row in enumerate(plan[start:start+10000],1):
                    offer={'currency':market['currency'],'marketplace_id':market['marketplace'],
                        'audience':'B2B','our_price':[{'schedule':[{'value_with_tax':float(row['business'])}]}]}
                    messages.append({'messageId':i,'sku':row['sku'],'operationType':'PATCH','productType':'PRODUCT',
                        'patches':[{'op':'replace','path':'/attributes/purchasable_offer','value':[offer]}]})
                payload={'header':{'sellerId':os.getenv('SP_API_SELLER_ID','A3RY0L9OY3TPHI').strip(),
                    'version':'2.0','issueLocale':'en_US'},'messages':messages}
                doc=api('POST','/feeds/2021-06-30/documents',json={'contentType':'application/json; charset=UTF-8'})
                upload=requests.put(doc['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json; charset=UTF-8'},timeout=90)
                upload.raise_for_status()
                result=api('POST','/feeds/2021-06-30/feeds',json={'feedType':'JSON_LISTINGS_FEED',
                    'marketplaceIds':[market['marketplace']],'inputFeedDocumentId':doc['feedDocumentId']})
                feeds[key]={**result,'count':len(messages)};save(state)
                print(country,key,feeds[key],flush=True)
    elif action == 'status':
        for country,market in state['markets'].items():
            for key,feed in market.get('feeds',{}).items():
                if 'result' not in feed:
                    result=api('GET','/feeds/2021-06-30/feeds/'+feed['feedId'])
                    feed['status']=result['processingStatus']
                    if result.get('resultFeedDocumentId'):
                        content=document('/feeds/2021-06-30/documents/'+result['resultFeedDocumentId'])
                        result_path=ROOT/f'business_price_result_{country}_{key}.json'
                        result_path.write_text(content)
                        report=json.loads(content);feed['result']=str(result_path);feed['summary']=report.get('summary')
                    save(state)
                print(country,key,feed,flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','collect','submit','status'])
    main(parser.parse_args().action)
