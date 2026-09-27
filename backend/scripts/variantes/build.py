import sys,json,copy
sys.path.insert(0,sys.argv[1] if len(sys.argv)>1 else '.')
from sp import *
DROP={'externally_assigned_product_identifier','purchasable_offer','fulfillment_availability','list_price','color','size','model_number','part_number','item_depth_width_height','item_weight','main_product_image_locator','swatch_product_image_locator','number_of_items','merchant_shipping_group','child_parent_sku_relationship','parentage_level','variation_theme','title_differentiation','other_product_image_locator_1','other_product_image_locator_2','other_product_image_locator_3','other_product_image_locator_4','other_product_image_locator_5','other_product_image_locator_6','other_product_image_locator_7','other_product_image_locator_8'}
def v(x): return [{"value":x,"marketplace_id":MP}]
def vl(x): return [{"value":x,"language_tag":"es_ES","marketplace_id":MP}]
def parent_payload(child_attrs,pt,title,theme,extra=None,main_image=None):
    a={k:copy.deepcopy(val) for k,val in child_attrs.items() if k not in DROP}
    a['item_name']=vl(title)
    a['brand']=vl('ROCKING GIFTS')
    a['parentage_level']=v('parent')
    a['variation_theme']=[{"name":theme,"marketplace_id":MP}]
    a['supplier_declared_has_product_identifier_exemption']=v(True)
    if main_image: a['main_product_image_locator']=[{"media_location":main_image,"marketplace_id":MP}]
    if extra: a.update(extra)
    if pt not in ('SCULPTURE','LAMP'): a.pop('power_plug_type',None)
    return {"productType":pt,"requirements":"LISTING_PRODUCT_ONLY","attributes":a}
def child_patches(parent_sku,theme,size=None,color=None,color_map=None,extra=None):
    p=[{"op":"replace","path":"/attributes/parentage_level","value":v('child')},
       {"op":"replace","path":"/attributes/child_parent_sku_relationship","value":[{"child_relationship_type":"variation","parent_sku":parent_sku,"marketplace_id":MP}]},
       {"op":"replace","path":"/attributes/variation_theme","value":[{"name":theme,"marketplace_id":MP}]},
       {"op":"replace","path":"/attributes/brand","value":vl('ROCKING GIFTS')}]
    if size: p.append({"op":"replace","path":"/attributes/size","value":vl(size)})
    if color: p.append({"op":"replace","path":"/attributes/color","value":[{"value":color,"standardized_values":[color_map] if color_map else None,"language_tag":"es_ES","marketplace_id":MP}] if color_map else vl(color)})
    for k,val in (extra or {}).items(): p.append({"op":"replace","path":f"/attributes/{k}","value":val})
    return p
