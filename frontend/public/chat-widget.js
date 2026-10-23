/*
 * Vidal Regals — chat widget (specs/chatbot/chatbot.spec.md).
 * Embed in PrestaShop (footer of the theme or a "custom HTML" block):
 *   <script src="https://amazonapiseller.vercel.app/chat-widget.js" defer></script>
 * Optional attributes: data-color="#187f97" (button color), data-api="https://…/api/public/chat".
 */
(function () {
  "use strict";
  if (window.__vrChatLoaded) return;
  window.__vrChatLoaded = true;

  var script = document.currentScript;
  // If a theme module bundles or injects this file, currentScript is not ours: fall back to the deployment.
  var DEFAULT_ORIGIN = "https://amazonapiseller.vercel.app";
  var scriptOrigin = script && script.src && /\/chat-widget\.js(\?|$)/.test(script.src) ? new URL(script.src).origin : DEFAULT_ORIGIN;
  var API_URL = (script && script.getAttribute("data-api")) || scriptOrigin + "/api/public/chat";
  var COLOR = (script && script.getAttribute("data-color")) || "#187f97";
  var STORAGE_KEY = "vr-chat-v1";
  var MAX_STORED = 30;

  var lang = (document.documentElement.lang || navigator.language || "es").slice(0, 2).toLowerCase();
  var TEXTS = {
    es: { title: "Asistente Vidal Regals", hello: "¡Hola! Soy el asistente de Vidal Regals. ¿Qué estás buscando? También puedo resolver dudas sobre envíos, devoluciones o pagos.", placeholder: "Escribe tu mensaje…", send: "Enviar", open: "Abrir chat", close: "Cerrar chat", ai: "Asistente automático. Puede cometer errores.", error: "No he podido conectar. Inténtalo de nuevo en un momento.", view: "Ver producto", out: "Sin stock", reset: "Nueva conversación" },
    en: { title: "Vidal Regals Assistant", hello: "Hi! I'm the Vidal Regals assistant. What are you looking for? I can also help with shipping, returns or payments.", placeholder: "Type your message…", send: "Send", open: "Open chat", close: "Close chat", ai: "Automated assistant. It can make mistakes.", error: "Couldn't connect. Please try again in a moment.", view: "View product", out: "Out of stock", reset: "New conversation" },
    fr: { title: "Assistant Vidal Regals", hello: "Bonjour ! Je suis l'assistant de Vidal Regals. Que recherchez-vous ? Je peux aussi répondre à vos questions sur la livraison, les retours ou le paiement.", placeholder: "Écrivez votre message…", send: "Envoyer", open: "Ouvrir le chat", close: "Fermer le chat", ai: "Assistant automatique. Il peut se tromper.", error: "Connexion impossible. Réessayez dans un instant.", view: "Voir le produit", out: "Rupture de stock", reset: "Nouvelle conversation" },
    de: { title: "Vidal Regals Assistent", hello: "Hallo! Ich bin der Assistent von Vidal Regals. Was suchen Sie? Ich helfe auch bei Fragen zu Versand, Rücksendungen oder Zahlung.", placeholder: "Nachricht schreiben…", send: "Senden", open: "Chat öffnen", close: "Chat schließen", ai: "Automatischer Assistent. Er kann Fehler machen.", error: "Keine Verbindung. Bitte gleich noch einmal versuchen.", view: "Zum Produkt", out: "Nicht vorrätig", reset: "Neues Gespräch" },
    it: { title: "Assistente Vidal Regals", hello: "Ciao! Sono l'assistente di Vidal Regals. Cosa stai cercando? Posso aiutarti anche con spedizioni, resi o pagamenti.", placeholder: "Scrivi il tuo messaggio…", send: "Invia", open: "Apri la chat", close: "Chiudi la chat", ai: "Assistente automatico. Può commettere errori.", error: "Connessione non riuscita. Riprova tra un momento.", view: "Vedi prodotto", out: "Esaurito", reset: "Nuova conversazione" },
  };
  var T = TEXTS[lang] || TEXTS.es;

  // ---------------------------------------------------------------- state (survives page navigation)
  function load() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.messages)) return parsed;
    } catch (e) { /* storage blocked: start fresh */ }
    return { open: false, messages: [] };
  }
  function save() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open: state.open, messages: state.messages.slice(-MAX_STORED) }));
    } catch (e) { /* ignore */ }
  }
  var state = load();
  var busy = false;
  var generation = 0; // bumped on reset so a late reply never lands in the new conversation

  // ---------------------------------------------------------------- DOM (shadow root isolates the theme CSS)
  var host = document.createElement("div");
  host.id = "vr-chat";
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

  var css =
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}" +
    ".launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:" + COLOR + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}" +
    ".launcher:hover{transform:scale(1.06)}.launcher:focus-visible{outline:3px solid #000;outline-offset:2px}" +
    ".panel{position:fixed;right:20px;bottom:92px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;color:#222;font-size:14px;line-height:1.45}" +
    ".panel.open{display:flex}" +
    ".head{background:" + COLOR + ";color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px}" +
    ".head h2{margin:0;font-size:15px;font-weight:600;flex:1}" +
    ".icon-btn{background:transparent;border:0;color:#fff;cursor:pointer;padding:4px;border-radius:6px;display:flex}" +
    ".icon-btn:hover{background:rgba(255,255,255,.18)}.icon-btn:focus-visible{outline:2px solid #fff}" +
    ".log{flex:1;overflow-y:auto;padding:14px;background:#f6f7f8;display:flex;flex-direction:column;gap:8px}" +
    ".msg{max-width:86%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}" +
    ".msg.bot{background:#fff;border:1px solid #e3e5e8;align-self:flex-start;border-bottom-left-radius:4px}" +
    ".msg.user{background:" + COLOR + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}" +
    ".msg a{color:inherit}" +
    ".card{align-self:flex-start;width:86%;display:flex;gap:10px;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:8px;text-decoration:none;color:#222}" +
    ".card:hover{border-color:" + COLOR + "}" +
    ".card img{width:72px;height:72px;object-fit:contain;border-radius:8px;background:#fff;flex:none}" +
    ".card .info{display:flex;flex-direction:column;gap:3px;min-width:0}" +
    ".card .name{font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
    ".card .price{font-weight:700;font-size:15px}" +
    ".card .cta{font-size:12px;color:" + COLOR + ";font-weight:600}" +
    ".card .out{font-size:12px;color:#b3261e}" +
    ".typing{align-self:flex-start;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:10px 12px;display:flex;gap:4px}" +
    ".typing span{width:6px;height:6px;border-radius:50%;background:#999;animation:b 1s infinite}" +
    ".typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}" +
    "@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}" +
    ".form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e5e8;background:#fff}" +
    ".form textarea{flex:1;resize:none;border:1px solid #cfd3d8;border-radius:10px;padding:9px 10px;font-size:14px;max-height:96px;min-height:40px;color:#222;background:#fff}" +
    ".form textarea:focus{outline:2px solid " + COLOR + ";outline-offset:-1px;border-color:transparent}" +
    ".form button{border:0;border-radius:10px;background:" + COLOR + ";color:#fff;padding:0 14px;font-weight:600;cursor:pointer;font-size:14px}" +
    ".form button:disabled{opacity:.5;cursor:default}" +
    ".note{font-size:11px;color:#666;text-align:center;padding:0 10px 8px;background:#fff}" +
    "@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.launcher{right:16px;bottom:16px}.panel.open+.launcher{display:none}}" +
    "@media (prefers-reduced-motion:reduce){.typing span{animation:none}.launcher{transition:none}}";

  var CHAT_ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var RESET_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

  root.innerHTML =
    "<style>" + css + "</style>" +
    '<section class="panel" role="dialog" aria-label="' + T.title + '">' +
    '<div class="head"><h2>' + T.title + "</h2>" +
    '<button class="icon-btn reset" type="button" title="' + T.reset + '" aria-label="' + T.reset + '">' + RESET_ICON + "</button>" +
    '<button class="icon-btn close" type="button" title="' + T.close + '" aria-label="' + T.close + '">' + CLOSE_ICON + "</button></div>" +
    '<div class="log" aria-live="polite"></div>' +
    '<form class="form"><textarea rows="1" maxlength="1000" aria-label="' + T.placeholder + '" placeholder="' + T.placeholder + '"></textarea>' +
    '<button type="submit">' + T.send + "</button></form>" +
    '<div class="note">' + T.ai + "</div></section>" +
    '<button class="launcher" type="button" aria-label="' + T.open + '">' + CHAT_ICON + "</button>";

  var panel = root.querySelector(".panel");
  var launcher = root.querySelector(".launcher");
  var log = root.querySelector(".log");
  var form = root.querySelector(".form");
  var input = root.querySelector("textarea");
  var sendBtn = root.querySelector(".form button");

  // ---------------------------------------------------------------- rendering (textContent only: no HTML from the API)
  function formatPrice(value) {
    try {
      return new Intl.NumberFormat(lang + "-ES", { style: "currency", currency: "EUR" }).format(value);
    } catch (e) {
      return value.toFixed(2) + " €";
    }
  }

  function renderText(role, text) {
    var div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "bot");
    div.textContent = text;
    log.appendChild(div);
  }

  function safeUrl(url) {
    try {
      var parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "#";
    } catch (e) {
      return "#";
    }
  }

  function renderProduct(p) {
    var a = document.createElement("a");
    a.className = "card";
    a.href = safeUrl(p.url);
    if (p.image) {
      var img = document.createElement("img");
      img.src = safeUrl(p.image);
      img.alt = "";
      img.loading = "lazy";
      a.appendChild(img);
    }
    var info = document.createElement("div");
    info.className = "info";
    var name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    var price = document.createElement("span");
    price.className = "price";
    price.textContent = formatPrice(p.price);
    var cta = document.createElement("span");
    cta.className = p.inStock ? "cta" : "out";
    cta.textContent = p.inStock ? T.view + " →" : T.out;
    info.appendChild(name);
    info.appendChild(price);
    info.appendChild(cta);
    a.appendChild(info);
    log.appendChild(a);
  }

  function renderMessage(m) {
    if (m.role === "user") return renderText("user", m.text);
    (m.segments || []).forEach(function (s) {
      if (s.type === "product" && s.product) renderProduct(s.product);
      else if (s.type === "text") renderText("bot", s.text);
    });
  }

  function renderAll() {
    log.textContent = "";
    renderText("bot", T.hello);
    state.messages.forEach(renderMessage);
    log.scrollTop = log.scrollHeight;
  }

  function setOpen(open, focus) {
    state.open = open;
    panel.classList.toggle("open", open);
    launcher.setAttribute("aria-label", open ? T.close : T.open);
    launcher.innerHTML = open ? CLOSE_ICON : CHAT_ICON;
    save();
    if (open) log.scrollTop = log.scrollHeight;
    if (open && focus) input.focus();
  }

  // ---------------------------------------------------------------- API
  function toApiTurns() {
    return state.messages.map(function (m) {
      if (m.role === "user") return { role: "user", text: m.text };
      var text = (m.segments || [])
        .map(function (s) { return s.type === "product" ? "{{producto:" + s.product.id + "}}" : s.text; })
        .join("\n");
      return { role: "assistant", text: text };
    }).filter(function (t) { return t.text; });
  }

  function showTyping() {
    var t = document.createElement("div");
    t.className = "typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    log.appendChild(t);
    log.scrollTop = log.scrollHeight;
    return t;
  }

  function send(text) {
    if (busy || !text) return;
    busy = true;
    var sentIn = generation;
    sendBtn.disabled = true;
    state.messages.push({ role: "user", text: text });
    renderText("user", text);
    save();
    var typing = showTyping();

    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: toApiTurns() }),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (sentIn !== generation) return;
        var segments = Array.isArray(data.segments) && data.segments.length ? data.segments : [{ type: "text", text: T.error }];
        var reply = { role: "assistant", segments: segments };
        state.messages.push(reply);
        typing.remove();
        renderMessage(reply);
      })
      .catch(function () {
        if (sentIn !== generation) return;
        typing.remove();
        renderText("bot", T.error);
      })
      .then(function () {
        busy = false;
        sendBtn.disabled = false;
        save();
        log.scrollTop = log.scrollHeight;
      });
  }

  // ---------------------------------------------------------------- events
  launcher.addEventListener("click", function () { setOpen(!state.open, true); });
  root.querySelector(".close").addEventListener("click", function () { setOpen(false); launcher.focus(); });
  root.querySelector(".reset").addEventListener("click", function () {
    generation += 1;
    busy = false;
    sendBtn.disabled = false;
    state.messages = [];
    save();
    renderAll();
    input.focus();
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    input.value = "";
    send(text);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { setOpen(false); launcher.focus(); }
  });

  renderAll();
  setOpen(state.open);
})();
