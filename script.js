/* ========= CONFIG ========= */
const WORKER_URL = "https://silent-brook-0fad.blades79.workers.dev"; // your Cloudflare Worker
const STORAGE_KEY = "loreal.selectedProducts.v1";

/* ========= DOM ========= */
const categoryFilter = document.getElementById("categoryFilter");
const searchInput    = document.getElementById("productSearch");
const clearSearchBtn = document.getElementById("clearSearch");
const productsContainer = document.getElementById("productsContainer");
const selectedList   = document.getElementById("selectedProductsList");
const generateBtn    = document.getElementById("generateRoutine");
const chatWindow     = document.getElementById("chatWindow");
const chatForm       = document.getElementById("chatForm");
const userInput      = document.getElementById("userInput");
const rtlToggle      = document.getElementById("rtlToggle");

/* Modal elements */
const modal = document.getElementById("productModal");
const modalClose = document.getElementById("modalClose");
const modalImg = document.getElementById("modalImg");
const modalTitle = document.getElementById("modalTitle");
const modalBrand = document.getElementById("modalBrand");
const modalCategory = document.getElementById("modalCategory");
const modalDesc = document.getElementById("modalDesc");

/* ========= STATE ========= */
let allProducts = [];
let selected = loadSelected();     // [{id, ...product}]
let convo = [];                    // messages for OpenAI chat

/* ========= INIT ========= */
init();
async function init() {
  // Load products.json
  allProducts = await fetch("products.json").then(r => r.json()).then(x => x.products || []);
  renderSelectedChips();
  renderProducts();

  // Events
  categoryFilter.addEventListener("change", renderProducts);
  searchInput.addEventListener("input", renderProducts);
  clearSearchBtn.addEventListener("click", () => { searchInput.value = ""; renderProducts(); searchInput.focus(); });

  generateBtn.addEventListener("click", onGenerateRoutine);
  chatForm.addEventListener("submit", onChatSubmit);

  // RTL toggle
  rtlToggle.addEventListener("click", () => {
    const isOn = document.body.classList.toggle("rtl");
    rtlToggle.setAttribute("aria-pressed", String(isOn));
  });

  // Modal
  modalClose.addEventListener("click", () => modal.close());
  modal.addEventListener("close", () => modal.setAttribute("aria-hidden", "true"));

  // Seed chat
  addAssistant("Hello! I’m your L’Oréal routine advisor. Select products above or ask me anything.");
}

/* ========= RENDER ========= */
function renderProducts() {
  const term = (searchInput.value || "").toLowerCase().trim();
  const cat  = categoryFilter.value || "";

  let list = [...allProducts];
  if (cat) list = list.filter(p => (p.category || "").toLowerCase() === cat.toLowerCase());
  if (term) {
    list = list.filter(p => {
      return (p.name || "").toLowerCase().includes(term) ||
             (p.brand || "").toLowerCase().includes(term) ||
             (p.category || "").toLowerCase().includes(term);
    });
  }

  if (!list.length) {
    productsContainer.innerHTML = `<div class="placeholder-message">No products match your filters.</div>`;
    return;
  }

  productsContainer.innerHTML = list.map(p => productCardHTML(p)).join("");
  // Bind buttons
  list.forEach(p => {
    const selBtn = document.querySelector(`[data-sel="${p.id}"]`);
    const infoBtn = document.querySelector(`[data-info="${p.id}"]`);
    selBtn?.addEventListener("click", () => toggleSelected(p));
    infoBtn?.addEventListener("click", () => openModal(p));
    // keyboard toggle with Enter/Space
    selBtn?.addEventListener("keydown", (e)=>{ if (e.key === "Enter" || e.code === "Space") { e.preventDefault(); toggleSelected(p); }});
  });
}
function productCardHTML(p) {
  const isSelected = selected.some(s => s.id === p.id);
  return `
  <article class="product-card" aria-labelledby="p-title-${p.id}">
    <img src="${p.image}" alt="${p.name} product image"/>
    <div class="product-info">
      <h3 id="p-title-${p.id}">${escapeHTML(p.name)}</h3>
      <p><span class="badge">${escapeHTML(p.brand)}</span> • ${escapeHTML(p.category)}</p>
      <div class="card-actions">
        <button class="btn select-btn ${isSelected ? "primary":""}" data-sel="${p.id}" aria-pressed="${isSelected}">
          ${isSelected ? '<i class="fa-solid fa-check"></i> Selected' : '<i class="fa-regular fa-square-plus"></i> Select'}
        </button>
        <button class="btn ghost" data-info="${p.id}" aria-label="View details for ${escapeHTML(p.name)}">
          <i class="fa-regular fa-circle-question"></i> Details
        </button>
      </div>
    </div>
  </article>`;
}

/* ========= SELECTED ========= */
function toggleSelected(prod) {
  const idx = selected.findIndex(p => p.id === prod.id);
  if (idx >= 0) selected.splice(idx, 1);
  else selected.push(prod);
  saveSelected();
  renderSelectedChips();
  renderProducts(); // update button states
}
function renderSelectedChips() {
  if (!selected.length) { selectedList.innerHTML = `<span class="badge">None selected yet</span>`; return; }
  selectedList.innerHTML = selected.map(p => `
    <span class="selected-chip" aria-label="${escapeHTML(p.name)} selected">
      ${escapeHTML(p.brand)} • ${escapeHTML(p.name)}
      <button aria-label="Remove ${escapeHTML(p.name)}" data-remove="${p.id}">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </span>
  `).join("");
  // bind remove
  selected.forEach(p => {
    const btn = selectedList.querySelector(`[data-remove="${p.id}"]`);
    btn?.addEventListener("click", ()=> { toggleSelected(p); });
  });
}
function saveSelected(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); }
function loadSelected(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

/* ========= MODAL ========= */
function openModal(p){
  modalImg.src = p.image; modalImg.alt = p.name + " product image";
  modalTitle.textContent = p.name;
  modalBrand.textContent = `Brand: ${p.brand}`;
  modalCategory.textContent = `Category: ${p.category}`;
  modalDesc.textContent = p.description || "No description provided.";
  modal.showModal();
  modal.setAttribute("aria-hidden", "false");
}

/* ========= CHAT / OPENAI via Worker ========= */
function addMsg(role, text){
  const wrap = document.createElement("div");
  wrap.className = `msg ${role === "user" ? "user": "assistant"}`;
  wrap.innerHTML = `
    <div class="avatar">${role === "user" ? "U" : "A"}</div>
    <div class="bubble">${formatMarkdown(text)}</div>
  `;
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}
const addUser = (t)=>{ addMsg("user", t); };
const addAssistant = (t)=>{ addMsg("assistant", t); };

async function onGenerateRoutine(){
  if (!selected.length) {
    addAssistant("Please select at least one product first. You can pick from different categories above.");
    return;
  }

  // Build a rich system + user prompt
  convo = []; // reset convo so follow-ups start after the routine
  const system = {
    role: "system",
    content:
`You are a luxury L’Oréal skincare & beauty advisor.
Write with a premium, encouraging tone. Be concise but detailed.
Return a personalized routine that uses ONLY the provided selected products.
Structure with clear headings and bullet steps. Include AM/PM, order of use, amounts, and pro tips.
If a product category is missing (e.g., cleanser), mention the gap briefly and suggest how to adapt with the selected items.`
  };

  const selectedSummary = selected.map(p => `- ${p.brand} — ${p.name} [${p.category}]: ${p.description}`).join("\n");
  const user = {
    role: "user",
    content:
`Create a routine from these selected L’Oréal brand products:

${selectedSummary}

Output format:
1) Title line
2) AM Routine (bullets, application order)
3) PM Routine (bullets)
4) Weekly / Pro Tips (bullets)
Keep it friendly, expert, and easy to scan.`
  };

  addAssistant("Generating your routine… ✨");
  const reply = await callWorker([system, user]);
  if (reply.ok) {
    const content = reply.text;
    addAssistant(content);
    // Start convo memory with system + the routine so follow-ups reference it
    convo = [system, user, { role:"assistant", content }];
  } else {
    addAssistant(`Sorry — I couldn’t generate the routine. ${reply.text || ""}`.trim());
  }
}

async function onChatSubmit(e){
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  userInput.value = "";
  addUser(text);

  if (!convo.length) {
    // No routine yet → give model context anyway
    convo = [{
      role: "system",
      content: "You are a luxury L’Oréal skincare & beauty advisor. Keep answers tight, on-topic, and helpful."
    }];
  }
  // Add the user message
  convo.push({ role: "user", content: text });

  const reply = await callWorker(convo);
  if (reply.ok) {
    const content = reply.text;
    convo.push({ role:"assistant", content });
    addAssistant(content);
  } else {
    addAssistant(`Sorry — I couldn’t get a response. ${reply.text || ""}`.trim());
  }
}

async function callWorker(messages){
  try {
    chatWindow.setAttribute("aria-busy", "true");
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });
    if (!res.ok) {
      const err = await safeText(res);
      return { ok:false, text:`(${res.status}) ${err}` };
    }
    const data = await res.json();
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    return { ok:true, text: content };
  } catch (e) {
    return { ok:false, text: e?.message || "Network error" };
  } finally {
    chatWindow.setAttribute("aria-busy", "false");
  }
}

/* ========= Utils ========= */
function escapeHTML(s=""){ return s.replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }
async function safeText(res){ try { return await res.text(); } catch { return ""; } }

// very small markdown → HTML (bold, lists, line breaks)
function formatMarkdown(md=""){
  let html = escapeHTML(md);
  html = html.replace(/^\s*[-•]\s(.+)$/gm, "<li>$1</li>"); // bullets
  html = html.replace(/(^|<\/li>\n?)(?=<li>)/g, "<ul>");    // open list (naive)
  html = html.replace(/(<li>.*<\/li>)(?!\n<li>)/gs, "$1</ul>"); // close list (naive)
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n{2,}/g, "<br/><br/>");
  return html;
}
