// 1. Setup IndexedDB (Offline Storage)
let db;
const SUPABASE_URL = "https://hewfiybgrkdnkzgsuprn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_g-zqvP6Rj9bMtSGCNpUn5w_itGippJ0";
const DEFAULT_SPEECH_LANGUAGE = { locale: "hi-IN", label: "Hindi / Hinglish" };
const OPTIONAL_SPEECH_LANGUAGES = [
  { locale: "bn-IN", label: "Bengali (বাংলা)" },
  { locale: "gu-IN", label: "Gujarati (ગુજરાતી)" },
  { locale: "kn-IN", label: "Kannada (ಕನ್ನಡ)" },
  { locale: "ml-IN", label: "Malayalam (മലയാളം)" },
  { locale: "mr-IN", label: "Marathi (मराठी)" },
  { locale: "pa-IN", label: "Punjabi (ਪੰਜਾਬੀ)" },
  { locale: "ta-IN", label: "Tamil (தமிழ்)" },
  { locale: "te-IN", label: "Telugu (తెలుగు)" },
  { locale: "ur-IN", label: "Urdu (اردو)" }
]; 
const SESSION_STORAGE_KEY = "bolkhata_supabase_session";
const BOUND_ACCOUNT_KEY = "bolkhata_bound_account";
const SYNC_META_KEY = "lastSyncedKeys";
const request = indexedDB.open("BolKhataDB", 5);

request.onupgradeneeded = (e) => {
  db = e.target.result;
  const previousVersion = e.oldVersion;
  const upgradeTransaction = e.target.transaction;
  if (!db.objectStoreNames.contains("khata")) {
    db.createObjectStore("khata", { keyPath: "name" });
  }
  if (!db.objectStoreNames.contains("orders")) {
    db.createObjectStore("orders", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("paid")) {
    db.createObjectStore("paid", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("deliveredOrders")) {
    db.createObjectStore("deliveredOrders", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("ledgerEntries")) {
    db.createObjectStore("ledgerEntries", { keyPath: "id", autoIncrement: true });

    if (previousVersion > 0) {
      const migratedAt = new Date().toISOString();
      upgradeTransaction.objectStore("khata").openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;

        const { name, amount } = cursor.value;
        upgradeTransaction.objectStore("ledgerEntries").add({
          name,
          type: "opening",
          amount,
          balanceAfter: amount,
          occurredAt: migratedAt,
          note: "Opening balance; original transaction date unavailable."
        });
        cursor.continue();
      };

      upgradeTransaction.objectStore("paid").openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;

        const { name, amount, paidAt } = cursor.value;
        upgradeTransaction.objectStore("ledgerEntries").add({
          name,
          type: "payment",
          amount,
          occurredAt: paidAt || migratedAt,
          note: "Imported from paid-credit history."
        });
        cursor.continue();
      };
    }
  }
  if (!db.objectStoreNames.contains("syncMeta")) {
    db.createObjectStore("syncMeta", { keyPath: "key" });
  }
};

request.onsuccess = (e) => {
  db = e.target.result;
  document.getElementById("exportCsvBtn").disabled = false;
  document.getElementById("downloadBackupBtn").disabled = false;
  document.getElementById("restoreBackupBtn").disabled = false;
  renderAll();
  initializeCloudAccount();
};

request.onerror = () => {
  const errorMessage = request.error ? request.error.message : "IndexedDB error";
  statusBox.textContent = `Could not open local records: ${errorMessage}`;
};

// 2. Voice Recognition Setup
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

const micBtn = document.getElementById("micBtn");
const statusBox = document.getElementById("statusBox");
const quickAddForm = document.getElementById("quickAddForm");
const quickAddInput = document.getElementById("quickAddInput");
const voiceLanguageSelect = document.getElementById("voiceLanguageSelect");
const signupSpeechLanguageSelect = document.getElementById("signupSpeechLanguage");
const profileSpeechLanguageSelect = document.getElementById("profileSpeechLanguage");
const offlineBadge = document.getElementById("offlineBadge");
const orderList = document.getElementById("orderList");
const khataList = document.getElementById("khataList");
const paidList = document.getElementById("paidList");
const deliveredList = document.getElementById("deliveredList");
const ledgerList = document.getElementById("ledgerList");
const ledgerCustomerSelect = document.getElementById("ledgerCustomer");
const customerStatement = document.getElementById("customerStatement");
const downloadCustomerStatementButton = document.getElementById("downloadCustomerStatement");
const shareCustomerStatementButton = document.getElementById("shareCustomerStatement");
const backupFileInput = document.getElementById("backupFileInput");
const storeNames = ["khata", "orders", "paid", "deliveredOrders", "ledgerEntries"];
let selectedCustomerStatement = null;
let editingOrderId = null;
let editingCreditName = null;
let editingPaidId = null;
let isListening = false;
let cloudSession = null;
let cloudReady = false;
let cloudSyncInProgress = false;
let syncTimer = null;
let lastSyncedSignature = null;
let lastSyncedKeys = new Set();
let authMode = "signin";

populateAdditionalLanguageSelect(signupSpeechLanguageSelect, "");
populateAdditionalLanguageSelect(profileSpeechLanguageSelect, "");
voiceLanguageSelect.disabled = !recognition;
updateVoiceLanguageOptions("");

khataList.addEventListener("click", (event) => {
  const control = event.target.closest("[data-credit-action]");
  if (!control) return;

  const name = control.dataset.creditName;
  if (control.dataset.creditAction === "share") {
    event.preventDefault();
    const confirmed = window.confirm(`Share ${name}'s ₹${control.dataset.creditAmount} balance using WhatsApp?`);
    if (!confirmed) {
      statusBox.textContent = "WhatsApp reminder canceled.";
      return;
    }

    const link = document.createElement("a");
    link.href = control.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
    statusBox.textContent = "WhatsApp opened. Review the reminder before sending it.";
  } else if (control.dataset.creditAction === "edit") {
    editingCreditName = name;
    renderAll();
  } else if (control.dataset.creditAction === "keep") {
    editingCreditName = null;
    statusBox.textContent = "Edit canceled. The credit amount was kept unchanged.";
    renderAll();
  } else if (control.dataset.creditAction === "cancel") {
    clearCredit(name, "Customer credit removed.");
  } else if (control.dataset.creditAction === "paid") {
    markCreditPaid(name);
  }
});

ledgerCustomerSelect.addEventListener("change", renderLedger);
downloadCustomerStatementButton.addEventListener("click", downloadCustomerStatement);
shareCustomerStatementButton.addEventListener("click", shareCustomerStatement);

document.getElementById("exportCsvBtn").addEventListener("click", () => {
  exportRecords("csv");
});

document.getElementById("downloadBackupBtn").addEventListener("click", () => {
  exportRecords("json");
});

document.getElementById("restoreBackupBtn").addEventListener("click", () => {
  backupFileInput.click();
});

backupFileInput.addEventListener("change", restoreBackupFromFile);

const accountDialog = document.getElementById("accountDialog");
document.getElementById("openAccountBtn").addEventListener("click", () => accountDialog.showModal());
document.getElementById("closeAccountBtn").addEventListener("click", () => accountDialog.close());
accountDialog.addEventListener("click", (event) => {
  if (event.target === accountDialog) accountDialog.close();
});
document.getElementById("authModeToggle").addEventListener("click", () => {
  setAuthMode(authMode === "signin" ? "signup" : "signin");
});
voiceLanguageSelect.addEventListener("change", () => {
  const language = getSpeechLanguage(voiceLanguageSelect.value);
  statusBox.textContent = `भाषा: ${language.label}। / Language: ${language.label}.`;
});
document.getElementById("authForm").addEventListener("submit", handleAuthSubmit);
document.getElementById("profileForm").addEventListener("submit", saveProfileDetails);
document.getElementById("signOutBtn").addEventListener("click", signOutOfCloud);
document.getElementById("syncNowBtn").addEventListener("click", () => {
  startCloudSync(true);
});
window.addEventListener("online", () => {
  if (cloudSession) startCloudSync(false);
});

khataList.addEventListener("submit", (event) => {
  if (!event.target.matches(".credit-edit-form")) return;
  event.preventDefault();

  const form = event.target;
  const name = form.dataset.creditName;
  const amountInput = form.elements.namedItem("amount");
  const amount = Number(amountInput.value);

  if (!amountInput.value.trim() || Number.isNaN(amount) || amount <= 0) {
    statusBox.textContent = "Enter a valid amount greater than zero.";
    amountInput.focus();
    return;
  }

  const tx = db.transaction(["khata", "ledgerEntries"], "readwrite");
  const store = tx.objectStore("khata");
  const getRequest = store.get(name);
  let creditFound = false;

  getRequest.onsuccess = () => {
    if (getRequest.result) {
      creditFound = true;
      const currentAmount = getRequest.result.amount;
      store.put({ ...getRequest.result, amount });
      if (currentAmount !== amount) {
        tx.objectStore("ledgerEntries").add({
          name,
          type: "adjustment",
          amount: amount - currentAmount,
          balanceAfter: amount,
          occurredAt: new Date().toISOString(),
          note: "Balance adjusted manually."
        });
      }
    }
  };

  tx.oncomplete = () => {
    editingCreditName = null;
    statusBox.textContent = creditFound ? `Updated credit for ${name} to ₹${amount}.` : "That customer credit record was not found.";
    renderAll();
  };
});

paidList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-paid-action]");
  if (!button) return;

  const id = Number(button.dataset.paidId);
  if (button.dataset.paidAction === "edit-name") {
    editingPaidId = id;
    renderAll();
  } else if (button.dataset.paidAction === "cancel-name") {
    editingPaidId = null;
    statusBox.textContent = "Name edit canceled.";
    renderAll();
  }
});

paidList.addEventListener("submit", (event) => {
  if (!event.target.matches(".paid-name-edit-form")) return;
  event.preventDefault();

  const form = event.target;
  const oldName = form.dataset.customerName;
  const newNameInput = form.elements.namedItem("name");
  const newName = newNameInput.value.trim();

  if (!newName) {
    statusBox.textContent = "Enter a customer name.";
    newNameInput.focus();
    return;
  }
  if (newName === oldName) {
    editingPaidId = null;
    statusBox.textContent = "The customer name is unchanged.";
    renderAll();
    return;
  }
  if (!window.confirm(`Change ${oldName} to ${newName} across current balances and all paid/ledger history?`)) {
    statusBox.textContent = "Name change canceled.";
    return;
  }

  renameCustomer(oldName, newName);
});

orderList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-order-action]");
  if (!button) return;

  const id = Number(button.dataset.orderId);
  if (button.dataset.orderAction === "edit") {
    editingOrderId = id;
    renderAll();
  } else if (button.dataset.orderAction === "keep") {
    editingOrderId = null;
    statusBox.textContent = "Edit canceled. The order was kept unchanged.";
    renderAll();
  } else if (button.dataset.orderAction === "cancel") {
    deleteOrder(id, "Supply order canceled.");
  } else if (button.dataset.orderAction === "done") {
    if (window.confirm("Kya aap sehmat hain? Are you sure this supply was delivered?")) {
      markOrderDelivered(id);
    }
  }
}); 

orderList.addEventListener("submit", (event) => {
  if (!event.target.matches(".order-edit-form")) return;
  event.preventDefault();

  const form = event.target;
  const id = Number(form.dataset.orderId);
  const item = form.elements.namedItem("item").value.trim();
  if (!item) {
    statusBox.textContent = "Enter an item and quantity before saving.";
    form.elements.namedItem("item").focus();
    return;
  }

  const tx = db.transaction("orders", "readwrite");
  const store = tx.objectStore("orders");
  const getRequest = store.get(id);
  let orderFound = false;

  getRequest.onsuccess = () => {
    if (getRequest.result) {
      orderFound = true;
      store.put({ ...getRequest.result, item });
    }
  };

  tx.oncomplete = () => {
    editingOrderId = null;
    statusBox.textContent = orderFound ? "Supply order updated." : "That supply order was not found.";
    renderAll();
  };
});

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.elements.namedItem("email").value.trim();
  const password = form.elements.namedItem("password").value;
  const fullName = form.elements.namedItem("name").value.trim();
  const profession = form.elements.namedItem("profession").value.trim();
  const additionalLanguage = form.elements.namedItem("additional_language").value;
  const buttons = form.querySelectorAll("button");
  buttons.forEach(button => { button.disabled = true; });
  setSyncStatus(authMode === "signup" ? "Creating account..." : "Signing in...");

  try {
    if (!navigator.onLine) throw new Error("Connect to the internet to sign in or create an account.");
    if (authMode === "signup" && (!fullName || !profession)) {
      throw new Error("Enter your name and profession or business.");
    }
    const result = await authRequest(
      authMode === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password",
      authMode === "signup"
        ? { email, password, data: { full_name: fullName, profession, additional_language: additionalLanguage } }
        : { email, password }
    );
    if (!result.access_token || !result.user) {
      setSyncStatus("Account created. Check your email to confirm it, then sign in here.");
      return;
    }

    await acceptCloudSession(makeSession(result));
    form.reset();
  } catch (error) {
    setSyncStatus(`Account request failed: ${error.message}`);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function populateAdditionalLanguageSelect(select, selectedLanguage) {
  select.replaceChildren(new Option("No extra language", ""));
  OPTIONAL_SPEECH_LANGUAGES.forEach(language => {
    select.add(new Option(language.label, language.locale));
  });
  select.value = OPTIONAL_SPEECH_LANGUAGES.some(language => language.locale === selectedLanguage)
    ? selectedLanguage
    : "";
}

function updateVoiceLanguageOptions(additionalLanguage) {
  const currentLanguage = voiceLanguageSelect.value;
  const extraLanguage = OPTIONAL_SPEECH_LANGUAGES.find(language => language.locale === additionalLanguage);
  voiceLanguageSelect.replaceChildren(new Option(`${DEFAULT_SPEECH_LANGUAGE.label} (default)`, DEFAULT_SPEECH_LANGUAGE.locale));
  if (extraLanguage) voiceLanguageSelect.add(new Option(extraLanguage.label, extraLanguage.locale));

  const allowedLanguages = [DEFAULT_SPEECH_LANGUAGE.locale];
  if (extraLanguage) allowedLanguages.push(extraLanguage.locale);
  voiceLanguageSelect.value = allowedLanguages.includes(currentLanguage)
    ? currentLanguage
    : DEFAULT_SPEECH_LANGUAGE.locale;
  if (recognition) recognition.lang = voiceLanguageSelect.value;
}

function getSpeechLanguage(locale) {
  if (locale === DEFAULT_SPEECH_LANGUAGE.locale) return DEFAULT_SPEECH_LANGUAGE;
  return OPTIONAL_SPEECH_LANGUAGES.find(language => language.locale === locale) || DEFAULT_SPEECH_LANGUAGE;
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === "signup";
  const profileFields = document.getElementById("signupProfileFields");
  const nameInput = document.getElementById("signupName");
  const professionInput = document.getElementById("signupProfession");
  profileFields.hidden = !isSignup;
  nameInput.required = isSignup;
  professionInput.required = isSignup;
  document.getElementById("authPassword").autocomplete = isSignup ? "new-password" : "current-password";
  document.getElementById("authSubmitBtn").textContent = isSignup ? "Create account" : "Sign in";
  document.getElementById("authModeToggle").textContent = isSignup
    ? "Already have an account? Sign in"
    : "New here? Create account";
  document.getElementById("accountDialogTitle").textContent = isSignup ? "Create your account" : "Login";
}

async function initializeCloudAccount() {
  let savedSession;
  try {
    savedSession = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
  } catch (error) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSyncStatus("Saved sign-in could not be read. Sign in again to sync.");
    return;
  }
  if (!savedSession || !savedSession.access_token || !savedSession.user) {
    setSyncStatus("लॉगिन नहीं है—डेटा इसी डिवाइस पर सेव है। / Signed out—data stays on this device.");
    return;
  }

  try {
    if (navigator.onLine && savedSession.expiresAt <= Date.now() + 60000 && savedSession.refresh_token) {
      savedSession = makeSession(await authRequest("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: savedSession.refresh_token
      }));
    }
    await acceptCloudSession(savedSession, false);
  } catch (error) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSyncStatus(`Could not restore sign-in: ${error.message}. Your local records are still available.`);
  }
}

function makeSession(result) {
  return {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expiresAt: result.expires_at ? result.expires_at * 1000 : Date.now() + (result.expires_in || 3600) * 1000,
    user: result.user
  };
}

async function acceptCloudSession(session, syncImmediately = true) {
  const boundAccount = localStorage.getItem(BOUND_ACCOUNT_KEY);
  if (boundAccount && boundAccount !== session.user.id) {
    throw new Error("This device's local records are linked to another shop account. Sign in with the original account.");
  }
  if (!boundAccount) localStorage.setItem(BOUND_ACCOUNT_KEY, session.user.id);

  cloudSession = session;
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  cloudReady = false;
  lastSyncedSignature = null;
  document.getElementById("authForm").hidden = true;
  document.getElementById("accountControls").hidden = false;
  const metadata = session.user.user_metadata || {};
  const fullName = metadata.full_name || metadata.name || "";
  const additionalLanguage = metadata.additional_language || "";
  document.getElementById("profileName").value = fullName;
  document.getElementById("profileProfession").value = metadata.profession || "";
  populateAdditionalLanguageSelect(profileSpeechLanguageSelect, additionalLanguage);
  updateVoiceLanguageOptions(additionalLanguage);
  document.getElementById("accountDialogTitle").textContent = "Your account";
  document.getElementById("accountLabel").textContent = fullName
    ? `${fullName} — ${session.user.email}`
    : `Signed in as ${session.user.email}`;
  document.getElementById("openAccountBtn").textContent = "Account";

  if (!navigator.onLine) {
    setSyncStatus("Signed in. Offline: changes are saved on this device and will sync when internet returns.");
  } else if (syncImmediately) {
    await startCloudSync(false);
  } else {
    await startCloudSync(false);
  }
}

async function signOutOfCloud() {
  const session = cloudSession;
  cloudSession = null;
  cloudReady = false;
  lastSyncedSignature = null;
  localStorage.removeItem(SESSION_STORAGE_KEY);
  document.getElementById("authForm").hidden = false;
  document.getElementById("accountControls").hidden = true;
  document.getElementById("openAccountBtn").textContent = "Login";
  document.getElementById("accountDialogTitle").textContent = "Login";
  setAuthMode("signin");
  populateAdditionalLanguageSelect(profileSpeechLanguageSelect, "");
  updateVoiceLanguageOptions("");
  setSyncStatus("Signed out. Your records remain on this device.");
  if (session && navigator.onLine) {
    try {
      await authRequest("/auth/v1/logout", null, session.access_token);
    } catch (error) {
      setSyncStatus(`Signed out on this device. Server sign-out could not complete: ${error.message}`);
    }
  }
}

async function saveProfileDetails(event) {
  event.preventDefault();
  if (!cloudSession) {
    setSyncStatus("Sign in to save your account details.");
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("Connect to the internet to save account details. Your khata records remain available offline.");
    return;
  }

  const form = event.currentTarget;
  const fullName = form.elements.namedItem("name").value.trim();
  const profession = form.elements.namedItem("profession").value.trim();
  const additionalLanguage = form.elements.namedItem("additional_language").value;
  const saveButton = document.getElementById("saveProfileBtn");
  if (!fullName || !profession) {
    setSyncStatus("Enter your name and profession or business.");
    return;
  }

  saveButton.disabled = true;
  setSyncStatus("Saving account details...");
  try {
    const updatedUser = await authRequest(
      "/auth/v1/user",
      { data: { full_name: fullName, profession, additional_language: additionalLanguage } },
      cloudSession.access_token,
      "PUT"
    );
    if (!updatedUser || updatedUser.id !== cloudSession.user.id) {
      throw new Error("The server did not confirm the profile update.");
    }
    cloudSession.user = {
      ...updatedUser,
      user_metadata: {
        ...(updatedUser.user_metadata || {}),
        full_name: fullName,
        profession,
        additional_language: additionalLanguage
      }
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(cloudSession));
    populateAdditionalLanguageSelect(profileSpeechLanguageSelect, additionalLanguage);
    updateVoiceLanguageOptions(additionalLanguage);
    document.getElementById("accountLabel").textContent = `${fullName} — ${cloudSession.user.email}`;
    setSyncStatus("Account details and voice-language preference saved.");
  } catch (error) {
    setSyncStatus(`Could not save account details: ${error.message}`);
  } finally {
    saveButton.disabled = false;
  }
}

function authHeaders(accessToken) {
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

async function authRequest(path, body, accessToken, method = "POST") {
  const headers = authHeaders(accessToken);
  const options = { method, headers };
  if (body !== null) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${SUPABASE_URL}${path}`, options);
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result && (result.msg || result.message || result.error_description)
      ? (result.msg || result.message || result.error_description)
      : `Server returned ${response.status}`);
  }
  return result;
}

function setSyncStatus(message) {
  const syncStatus = document.getElementById("syncStatus");
  if (syncStatus) syncStatus.textContent = message;
}

function scheduleCloudSync() {
  if (!cloudSession || !cloudReady || cloudSyncInProgress || !navigator.onLine) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => startCloudSync(false), 1200);
}

async function startCloudSync() {
  if (!db || !cloudSession || cloudSyncInProgress) return;
  if (!navigator.onLine) {
    setSyncStatus("Offline: changes are saved on this device and will sync when internet returns.");
    return;
  }

  cloudSyncInProgress = true;
  const syncButton = document.getElementById("syncNowBtn");
  syncButton.disabled = true;
  setSyncStatus(cloudReady ? "Syncing local records to cloud..." : "Connecting local records to cloud...");
  const firstCloudSync = !cloudReady;

  try {
    if (cloudSession.expiresAt <= Date.now() + 60000) {
      if (!cloudSession.refresh_token) throw new Error("Session expired. Sign in again.");
      cloudSession = makeSession(await authRequest("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: cloudSession.refresh_token
      }));
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(cloudSession));
    }

    if (cloudReady) {
      await syncLocalChanges();
    } else {
      const remoteRows = await fetchCloudRows();
      const localRows = await readLocalCloudRows();
      const localKeys = new Set(localRows.map(cloudRowKey));
      lastSyncedKeys = await readLastSyncedKeys();
      const rowsToImport = remoteRows.filter((row) => {
        const key = cloudRowKey(row);
        return !localKeys.has(key) && !lastSyncedKeys.has(key);
      });
      await importCloudRows(rowsToImport);
      await syncLocalChanges(remoteRows);
    }

    if (firstCloudSync) renderAll();
    setSyncStatus(`Synced to cloud at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
  } catch (error) {
    setSyncStatus(`Cloud sync failed: ${error.message}. Local records are safe on this device.`);
  } finally {
    cloudSyncInProgress = false;
    syncButton.disabled = false;
  }
}

function getCloudRecordKey(collection, record) {
  return collection === "khata" ? String(record.name) : String(record.id);
}

function cloudRowKey(row) {
  return `${row.collection}\u0000${row.record_key}`;
}

function readLocalCloudRows() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readonly");
    const snapshot = {};
    let remaining = storeNames.length;
    storeNames.forEach((collection) => {
      const getRequest = tx.objectStore(collection).getAll();
      getRequest.onsuccess = () => {
        snapshot[collection] = getRequest.result;
        remaining -= 1;
        if (remaining === 0) {
          const rows = storeNames.flatMap(name => snapshot[name].map(record => ({
            owner_id: cloudSession.user.id,
            collection: name,
            record_key: getCloudRecordKey(name, record),
            data: record
          })));
          rows.sort((a, b) => cloudRowKey(a).localeCompare(cloudRowKey(b)));
          resolve(rows);
        }
      };
      getRequest.onerror = () => reject(new Error(`Could not read local ${collection} records.`));
    });
    tx.onerror = () => reject(new Error(tx.error ? tx.error.message : "Could not read local records."));
  });
}

async function fetchCloudRows() {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const params = new URLSearchParams({
      select: "collection,record_key,data",
      owner_id: `eq.${cloudSession.user.id}`,
      order: "collection.asc,record_key.asc",
      limit: String(pageSize),
      offset: String(offset)
    });
    const response = await fetch(`${SUPABASE_URL}/rest/v1/khata_records?${params}`, {
      headers: authHeaders(cloudSession.access_token)
    });
    const page = await readApiResponse(response);
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += pageSize;
  }
}

async function readApiResponse(response) {
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result && (result.message || result.details || result.hint)
      ? [result.message, result.details, result.hint].filter(Boolean).join(" ")
      : `Server returned ${response.status}`);
  }
  return result;
}

function readLastSyncedKeys() {
  return new Promise((resolve, reject) => {
    const getRequest = db.transaction("syncMeta", "readonly").objectStore("syncMeta").get(SYNC_META_KEY);
    getRequest.onsuccess = () => resolve(new Set(getRequest.result ? getRequest.result.value : []));
    getRequest.onerror = () => reject(new Error("Could not read local sync history."));
  });
}

function saveLastSyncedKeys(keys) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("syncMeta", "readwrite");
    tx.objectStore("syncMeta").put({ key: SYNC_META_KEY, value: [...keys] });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new Error(tx.error ? tx.error.message : "Could not save sync history."));
  });
}

async function importCloudRows(rows) {
  const imports = rows.filter((row) => {
    if (!storeNames.includes(row.collection) || !row.data || typeof row.data !== "object") return false;
    return getCloudRecordKey(row.collection, row.data) === row.record_key;
  });
  if (!imports.length) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    imports.forEach(row => tx.objectStore(row.collection).put(row.data));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new Error(tx.error ? tx.error.message : "Could not import cloud records."));
  });
}

async function syncLocalChanges(remoteRows) {
  const localRows = await readLocalCloudRows();
  const currentKeys = new Set(localRows.map(cloudRowKey));
  const knownKeys = lastSyncedKeys.size ? lastSyncedKeys : await readLastSyncedKeys();
  const remote = remoteRows || await fetchCloudRows();
  const currentSignature = JSON.stringify(localRows);
  if (cloudReady && currentSignature === lastSyncedSignature) return;

  for (let index = 0; index < localRows.length; index += 200) {
    const params = new URLSearchParams({ on_conflict: "owner_id,collection,record_key" });
    const response = await fetch(`${SUPABASE_URL}/rest/v1/khata_records?${params}`, {
      method: "POST",
      headers: {
        ...authHeaders(cloudSession.access_token),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(localRows.slice(index, index + 200))
    });
    await readApiResponse(response);
  }

  const remoteKeys = new Set(remote.map(cloudRowKey));
  const deletions = [...remoteKeys].filter(key => knownKeys.has(key) && !currentKeys.has(key));
  for (const key of deletions) {
    const [collection, recordKey] = key.split("\u0000");
    const params = new URLSearchParams({
      owner_id: `eq.${cloudSession.user.id}`,
      collection: `eq.${collection}`,
      record_key: `eq.${recordKey}`
    });
    const response = await fetch(`${SUPABASE_URL}/rest/v1/khata_records?${params}`, {
      method: "DELETE",
      headers: authHeaders(cloudSession.access_token)
    });
    await readApiResponse(response);
  }

  lastSyncedKeys = currentKeys;
  await saveLastSyncedKeys(currentKeys);
  lastSyncedSignature = currentSignature;
  cloudReady = true;
}

function updateOfflineBadge() {
  const connection = navigator.onLine ? "online" : "offline";
  offlineBadge.title = `Browser reports ${connection}; your data is stored locally in IndexedDB.`;
  offlineBadge.setAttribute("aria-label", `Offline Mode Ready (IndexedDB). Browser reports ${connection}.`);
}

updateOfflineBadge();
window.addEventListener("online", updateOfflineBadge);
window.addEventListener("offline", updateOfflineBadge);

if (recognition) {
  recognition.lang = "hi-IN";
  recognition.interimResults = false;

  micBtn.onclick = () => {
    if (isListening) {
      isListening = false;
      recognition.stop();
      setMicButton(false);
      statusBox.textContent = "सुनना बंद किया। / Listening stopped.";
      return;
    }

    startListening();
  };

  recognition.onresult = (event) => {
    if (!isListening) return;

    const result = event.results[event.results.length - 1];
    if (!result.isFinal) return;

    const transcript = result[0].transcript.trim();
    if (!transcript) {
      statusBox.textContent = "आवाज़ समझ नहीं आई—फिर बोलें। / Didn't catch that—please try again.";
      return;
    }

    isListening = false;
    setMicButton(false);
    statusBox.textContent = `सुना: "${transcript}" / Heard: "${transcript}"`;
    processCommand(transcript, true, recognition.lang);
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      statusBox.textContent = "आवाज़ नहीं मिली—फिर बोलें। / No speech detected—please try again.";
      return;
    }

    isListening = false;
    setMicButton(false);
    statusBox.textContent = getSpeechErrorMessage(event.error);
  };

  recognition.onend = () => {
    if (isListening) {
      window.setTimeout(() => {
        if (!isListening) return;
        try {
          recognition.start();
        } catch (error) {
          isListening = false;
          setMicButton(false);
          statusBox.textContent = `आवाज़ फिर शुरू नहीं हुई। / Could not restart voice input: ${error.message}`;
        }
      }, 250);
      return;
    }

    setMicButton(false);
  };
} else {
  micBtn.disabled = true;
  micBtn.textContent = "आवाज़ नहीं / Voice unavailable";
  statusBox.textContent = "यहाँ आवाज़ उपलब्ध नहीं। नीचे लिखें। / Voice unavailable here. Type below.";
}

function startListening() {
  isListening = true;
  setMicButton(true);
  recognition.lang = voiceLanguageSelect.value;
  statusBox.textContent = `${getSpeechLanguage(recognition.lang).label} में बोलें। रोकने के लिए फिर दबाएँ। / Speak now; tap again to stop.`;

  try {
    recognition.start();
  } catch (error) {
    isListening = false;
    setMicButton(false);
    statusBox.textContent = `आवाज़ शुरू नहीं हुई। / Could not start voice input: ${error.message}`;
  }
}

function setMicButton(listening) {
  micBtn.classList.toggle("listening", listening);
  micBtn.setAttribute("aria-pressed", String(listening));
  micBtn.textContent = listening ? "सुन रहा है / Listening… (रोकें / Stop)" : "🎙 बोलें / Speak";
}

function getSpeechErrorMessage(error) {
  const languageName = getSpeechLanguage(recognition ? recognition.lang : DEFAULT_SPEECH_LANGUAGE.locale).label;
  const messages = {
    "not-allowed": "माइक की अनुमति दें। / Allow microphone access in browser settings.",
    "service-not-allowed": "आवाज़ की अनुमति बंद है। / Check microphone and speech permissions.",
    "audio-capture": "माइक नहीं मिला। / No microphone found.",
    "network": "आवाज़ के लिए इंटरनेट चाहिए। / Speech service needs internet.",
    "language-not-supported": `${languageName} भाषा उपलब्ध नहीं। / ${languageName} recognition isn't supported.`,
    "aborted": "सुनना रद्द हुआ। / Voice input canceled."
  };

  return messages[error] || `आवाज़ नहीं चली (${error})। / Voice input failed (${error}). Check microphone permission.`;
}

quickAddForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = quickAddInput.value.trim();
  if (!text) {
    statusBox.textContent = "पहले उधार या सप्लाई लिखें। / Enter credit or supply first.";
    quickAddInput.focus();
    return;
  }
  if (!db) {
    statusBox.textContent = "डेटा लोड हो रहा है—फिर कोशिश करें। / Data is loading; try again shortly.";
    return;
  }

  processCommand(text, false);
  quickAddInput.value = "";
});

const SUPPLY_WORDS_BY_LANGUAGE = {
  "bn-IN": ["অর্ডার", "দুধ", "চিনি", "চা", "তেল"],
  "gu-IN": ["ઓર્ડર", "દૂધ", "ખાંડ", "ચા", "તેલ"],
  "kn-IN": ["ಆರ್ಡರ್", "ಹಾಲು", "ಸಕ್ಕರೆ", "ಚಹಾ", "ಎಣ್ಣೆ"],
  "ml-IN": ["ഓർഡർ", "പാൽ", "പഞ്ചസാര", "ചായ", "എണ്ണ"],
  "mr-IN": ["ऑर्डर", "मागवा", "दूध", "साखर", "चहा", "तेल"],
  "pa-IN": ["ਆਰਡਰ", "ਮੰਗਵਾਓ", "ਦੁੱਧ", "ਖੰਡ", "ਚਾਹ", "ਤੇਲ"],
  "ta-IN": ["ஆர்டர்", "பால்", "சர்க்கரை", "தேநீர்", "எண்ணெய்"],
  "te-IN": ["ఆర్డర్", "పాలు", "చక్కెర", "టీ", "నూనె"],
  "ur-IN": ["آرڈر", "دودھ", "چینی", "چائے", "تیل"]
};

// 3. Smart Command Parser (Extracts Name, Amount, or Supply Order)
function processCommand(text, useVoiceConfirmation = true, speechLocale = DEFAULT_SPEECH_LANGUAGE.locale) {
  const lower = normalizeIndianDigits(text).toLocaleLowerCase("hi-IN");
  const numberMatch = lower.match(/\d+/);
  const amount = numberMatch ? parseInt(numberMatch[0], 10) : parseHindiNumber(lower);
  const hasProductQuantity = /\d+\s*(?:kg|g|grams?|lit(?:er|re)s?|packets?|किलो|किलोग्राम|लीटर|पैकेट|ग्राम)/i.test(lower);
  const localizedSupplyWords = SUPPLY_WORDS_BY_LANGUAGE[speechLocale] || [];

  if (lower.includes("order") || lower.includes("milk") || lower.includes("sugar") || lower.includes("tea") || lower.includes("peanut") ||
      lower.includes("ऑर्डर") || lower.includes("मंगवाओ") || lower.includes("दूध") || lower.includes("चीनी") || lower.includes("चाय") ||
      localizedSupplyWords.some(word => lower.includes(word)) || hasProductQuantity) {
    const tx = db.transaction("orders", "readwrite");
    tx.objectStore("orders").add({ item: text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) });
    tx.oncomplete = () => {
      statusBox.textContent = "Added to tomorrow's order list.";
      if (useVoiceConfirmation) speakBack("Added to tomorrow's order list.");
      renderAll();
    };
  } else if (amount > 0) {
    const words = lower.replace(/[^\p{L}\p{M}\s]/gu, "").trim().split(/\s+/);
    const ignore = new Set([
      ...Object.keys(hindiNumberWords),
      "write", "add", "credit", "udhaar", "rupees", "rupee", "rs", "for", "to",
      "रुपये", "रुपया", "रुपए", "उधार", "लिखो", "जोड़ो", "जोड़", "के", "की", "का", "को", "ने", "पर", "लिए"
    ]);
    const nameWord = words.find(w => w && !ignore.has(w)) || "Customer";
    const customerName = nameWord.charAt(0).toUpperCase() + nameWord.slice(1).toLowerCase();

    const tx = db.transaction(["khata", "ledgerEntries"], "readwrite");
    const store = tx.objectStore("khata");
    const getReq = store.get(customerName);

    getReq.onsuccess = () => {
      const existing = getReq.result ? getReq.result.amount : 0;
      const balanceAfter = existing + amount;
      store.put({ name: customerName, amount: balanceAfter });
      tx.objectStore("ledgerEntries").add({
        name: customerName,
        type: "credit",
        amount,
        balanceAfter,
        occurredAt: new Date().toISOString()
      });
    };

    tx.oncomplete = () => {
      statusBox.textContent = `Added ₹${amount} credit for ${customerName}.`;
      if (useVoiceConfirmation) speakBack(`Added ${amount} rupees for ${customerName}`);
      renderAll();
    };
  } else {
    statusBox.textContent = `राशि नहीं मिली: "${text}"। जैसे: रमेश 50 रुपये। / Amount not found. Try: Ramesh 50 rupees.`;
  }
}

const hindiNumberWords = {
  "शून्य": 0, "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5,
  "छह": 6, "छः": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10, "ग्यारह": 11,
  "बारह": 12, "तेरह": 13, "चौदह": 14, "पंद्रह": 15, "सोलह": 16, "सत्रह": 17,
  "अठारह": 18, "उन्नीस": 19, "बीस": 20, "तीस": 30, "चालीस": 40, "पचास": 50,
  "साठ": 60, "सत्तर": 70, "अस्सी": 80, "नब्बे": 90, "सौ": 100, "हजार": 1000, "हज़ार": 1000
};

function normalizeIndianDigits(text) {
  const digitBlockStarts = [0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0660, 0x06F0];
  return Array.from(text, character => {
    const codePoint = character.codePointAt(0);
    const blockStart = digitBlockStarts.find(start => codePoint >= start && codePoint <= start + 9);
    return blockStart === undefined ? character : String(codePoint - blockStart);
  }).join("");
}

function parseHindiNumber(text) {
  const values = text.match(/[\p{L}\p{M}]+/gu) || [];
  let total = 0;
  let current = 0;
  let foundNumber = false;

  for (const word of values) {
    const value = hindiNumberWords[word];
    if (value === undefined) continue;
    foundNumber = true;
    if (value === 100) {
      current = (current || 1) * value;
    } else if (value === 1000) {
      total += (current || 1) * value;
      current = 0;
    } else {
      current += value;
    }
  }

  return foundNumber ? total + current : 0;
}

// 4. Voice Confirmation (Audio Feedback for Busy Vendors)
function speakBack(msg) {
  const speech = new SpeechSynthesisUtterance(msg);
  speech.lang = "en-IN";
  window.speechSynthesis.speak(speech);
}

// 5. Render Data from IndexedDB
function renderAll() {
  const khataDiv = document.getElementById("khataList");
  khataDiv.innerHTML = "";
  orderList.innerHTML = "";
  paidList.innerHTML = "";
  deliveredList.innerHTML = "";
  updateSummary();
  renderLedger();

  let hasCredits = false;
  db.transaction("khata", "readonly").objectStore("khata").openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      hasCredits = true;
      const { name, amount } = cursor.value;
      const message = `Hi ${name}, your outstanding credit at ChaiStall is ₹${amount}. Please let me know when you've paid. Thank you.`;
      const whatsappLink = `https://wa.me/?text=${encodeURIComponent(message)}`;

      if (editingCreditName === name) {
        khataDiv.innerHTML += `
          <div class="card credit-card" role="listitem">
            <form class="credit-edit-form" data-credit-name="${escapeHtml(name)}" aria-label="Edit credit for ${escapeHtml(name)}">
              <div class="credit-edit-main">
                <strong>${escapeHtml(name)}</strong>
                <div class="credit-edit-fields">
                  <label class="sr-only" for="credit-amount-${escapeHtml(name)}">Edit amount</label>
                  <input id="credit-amount-${escapeHtml(name)}" name="amount" class="credit-edit-input" type="number" min="1" step="1" value="${amount}" required />
                </div>
              </div>
              <div class="credit-edit-actions">
                <button class="btn-small btn-save" type="submit">Save</button>
                <button class="btn-small btn-clear" type="button" data-credit-action="keep" data-credit-name="${escapeHtml(name)}" aria-label="Keep current amount for ${escapeHtml(name)}">Keep amount</button>
              </div>
            </form>
          </div>`;
        window.requestAnimationFrame(() => {
          const nameInput = document.getElementById(`paid-customer-${id}`);
          if (nameInput) {
            nameInput.focus();
            nameInput.select();
          }
        });
      } else {
        khataDiv.innerHTML += `
          <div class="card credit-card" role="listitem">
            <div><strong>${escapeHtml(name)}</strong></div>
            <div class="credit-actions">
              <span class="amount">₹${amount}</span>
              <a href="${whatsappLink}" class="btn-small btn-whatsapp" target="_blank" rel="noopener noreferrer" data-credit-action="share" data-credit-name="${escapeHtml(name)}" data-credit-amount="${amount}" aria-label="Share credit for ${escapeHtml(name)} on WhatsApp (opens in a new tab)">WhatsApp</a>
              <button class="btn-small btn-edit" type="button" data-credit-action="edit" data-credit-name="${escapeHtml(name)}" aria-label="Edit credit for ${escapeHtml(name)}">Edit</button>
              <button class="btn-small btn-cancel" type="button" data-credit-action="cancel" data-credit-name="${escapeHtml(name)}" aria-label="Cancel credit for ${escapeHtml(name)}">Cancel</button>
              <button class="btn-small btn-clear" type="button" data-credit-action="paid" data-credit-name="${escapeHtml(name)}" aria-label="Mark credit for ${escapeHtml(name)} as paid">Mark paid</button>
            </div>
          </div>`;
      }
      cursor.continue();
    } else if (!hasCredits) {
      khataDiv.innerHTML = '<div class="empty-state" role="listitem">No outstanding customer credits yet.</div>';
    }
  };

    let hasPaidCredits = false;
    db.transaction("paid", "readonly").objectStore("paid").openCursor(null, "prev").onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        hasPaidCredits = true;
        const { id, name, amount, paidAt } = cursor.value;
        const paidDate = new Date(paidAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        if (id === editingPaidId) {
          paidList.innerHTML += `
            <div class="card paid-credit-card" role="listitem">
              <form class="paid-name-edit-form" data-paid-id="${id}" data-customer-name="${escapeHtml(name)}">
                <div class="paid-credit-main">
                  <label class="sr-only" for="paid-customer-${id}">Correct customer name</label>
                  <input id="paid-customer-${id}" name="name" class="paid-name-input" type="text" value="${escapeHtml(name)}" required autofocus />
                  <small class="record-meta">₹${amount} · Paid ${escapeHtml(paidDate)}</small>
                </div>
                <div class="paid-credit-actions">
                  <button class="btn-small btn-save" type="submit">Save name</button>
                  <button class="btn-small btn-clear" type="button" data-paid-action="cancel-name" data-paid-id="${id}">Cancel</button>
                </div>
              </form>
            </div>`;
        } else {
          paidList.innerHTML += `
            <div class="card paid-credit-card" role="listitem">
              <div class="paid-credit-main"><strong>${escapeHtml(name)}</strong><small class="record-meta">Paid ${escapeHtml(paidDate)}</small></div>
              <div class="paid-credit-actions">
                <span class="amount">₹${amount}</span>
                <button class="btn-small btn-edit" type="button" data-paid-action="edit-name" data-paid-id="${id}" aria-label="Edit customer name for ${escapeHtml(name)}">Edit name</button>
              </div>
            </div>`;
        }
        cursor.continue();
      } else if (!hasPaidCredits) {
        paidList.innerHTML = '<div class="empty-state" role="listitem">Paid credits will appear here.</div>';
      }
    };

  let hasOrders = false;
  db.transaction("orders", "readonly").objectStore("orders").openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      hasOrders = true;
      const { id, item, time } = cursor.value;
      if (id === editingOrderId) {
        orderList.innerHTML += `
          <div class="card" role="listitem">
            <form class="order-edit-form" data-order-id="${id}" aria-label="Edit supply order ${id}">
              <label class="sr-only" for="order-item-${id}">Change item name or quantity</label>
              <input id="order-item-${id}" name="item" class="order-edit-input" value="${escapeHtml(item)}" required />
              <div class="order-edit-actions">
                <button class="btn-small btn-save" type="submit">Save</button>
                <button class="btn-small btn-clear" type="button" data-order-action="keep" data-order-id="${id}" aria-label="Keep current supply order: ${escapeHtml(item)}">Keep order</button>
              </div>
            </form>
          </div>`;
      } else {
        orderList.innerHTML += `
        <div class="card" role="listitem">
          <div class="order-description">${escapeHtml(item)} <small class="record-meta">(${time})</small></div>
          <div class="order-actions">
            <button class="btn-small btn-edit" type="button" data-order-action="edit" data-order-id="${id}" aria-label="Edit supply order: ${escapeHtml(item)}">Edit</button>
            <button class="btn-small btn-cancel" type="button" data-order-action="cancel" data-order-id="${id}" aria-label="Cancel supply order: ${escapeHtml(item)}">Cancel</button>
            <button class="btn-small btn-clear" type="button" data-order-action="done" data-order-id="${id}" aria-label="Mark supply as delivered: ${escapeHtml(item)}">Done</button>
          </div>
        </div>`;
      }
      cursor.continue();
    } else if (!hasOrders) {
      orderList.innerHTML = '<div class="empty-state" role="listitem">No supply orders added yet.</div>';
    }
  };

  let hasDeliveredOrders = false;
  db.transaction("deliveredOrders", "readonly").objectStore("deliveredOrders").openCursor(null, "prev").onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      hasDeliveredOrders = true;
      const { item, deliveredAt } = cursor.value;
      const deliveryDate = new Date(deliveredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      deliveredList.innerHTML += `
        <div class="card delivered-card" role="listitem">
          <div class="order-description">${escapeHtml(item)}</div>
          <small class="record-meta">Delivered ${escapeHtml(deliveryDate)}</small>
        </div>`;
      cursor.continue();
    } else if (!hasDeliveredOrders) {
      deliveredList.innerHTML = '<div class="empty-state" role="listitem">Delivered orders will appear here.</div>';
    }
  };

  scheduleCloudSync();
}

function updateSummary() {
  const tx = db.transaction(["khata", "orders", "deliveredOrders"], "readonly");
  let outstanding = 0;
  let pending = 0;
  let deliveredToday = 0;
  const today = new Date().toDateString();

  tx.objectStore("khata").openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      outstanding += Number(cursor.value.amount) || 0;
      cursor.continue();
    }
  };

  tx.objectStore("orders").openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      pending += 1;
      cursor.continue();
    }
  };

  tx.objectStore("deliveredOrders").openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      if (new Date(cursor.value.deliveredAt).toDateString() === today) {
        deliveredToday += 1;
      }
      cursor.continue();
    }
  };

  tx.oncomplete = () => {
    document.getElementById("summaryOutstanding").textContent = `₹${outstanding.toLocaleString("en-IN")}`;
    document.getElementById("summaryPending").textContent = pending.toLocaleString("en-IN");
    document.getElementById("summaryDelivered").textContent = deliveredToday.toLocaleString("en-IN");
  };
  tx.onerror = () => {
    statusBox.textContent = `Could not update today's summary: ${tx.error ? tx.error.message : "IndexedDB error"}`;
  };
}

function renderLedger() {
  const tx = db.transaction(["ledgerEntries", "khata"], "readonly");
  const ledgerRequest = tx.objectStore("ledgerEntries").getAll();
  const creditRequest = tx.objectStore("khata").getAll();
  let entries;
  let credits;
  let ledgerLoaded = false;
  let creditsLoaded = false;

  const render = () => {
    if (!ledgerLoaded || !creditsLoaded) return;
    const selectedName = ledgerCustomerSelect.value;
    const names = [...new Set(entries.map(entry => entry.name))].sort((a, b) => a.localeCompare(b));

    while (ledgerCustomerSelect.options.length > 1) {
      ledgerCustomerSelect.remove(1);
    }
    names.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      ledgerCustomerSelect.append(option);
    });

    ledgerCustomerSelect.value = names.includes(selectedName) ? selectedName : "";
    ledgerList.innerHTML = "";

    if (!ledgerCustomerSelect.value) {
      customerStatement.hidden = true;
      selectedCustomerStatement = null;
      downloadCustomerStatementButton.disabled = true;
      shareCustomerStatementButton.disabled = true;
      ledgerList.innerHTML = `<div class="empty-state" role="listitem">${names.length ? "Choose a customer to view ledger entries." : "Transaction history will appear here."}</div>`;
      return;
    }

    const customerEntries = entries
      .filter(entry => entry.name === ledgerCustomerSelect.value)
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
    const activeCredit = credits.find(credit => credit.name === ledgerCustomerSelect.value);
    selectedCustomerStatement = {
      name: ledgerCustomerSelect.value,
      entries: customerEntries,
      currentBalance: activeCredit ? Number(activeCredit.amount) : 0
    };
    document.getElementById("customerCurrentBalance").textContent =
      `₹${selectedCustomerStatement.currentBalance.toLocaleString("en-IN")}`;
    customerStatement.hidden = false;
    downloadCustomerStatementButton.disabled = false;
    shareCustomerStatementButton.disabled = false;

    customerEntries.forEach((entry) => {
      const amount = Number(entry.amount);
      const isNegative = entry.type === "payment" || entry.type === "cancel" ||
        (entry.type === "adjustment" && amount < 0);
      const sign = isNegative ? "−" : "+";
      const title = getLedgerEntryTitle(entry.type);
      const occurredAt = new Date(entry.occurredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      const balance = Number.isFinite(entry.balanceAfter)
        ? `<small class="record-meta">Balance: ₹${Number(entry.balanceAfter).toLocaleString("en-IN")}</small>`
        : "";

      ledgerList.innerHTML += `
        <div class="card ledger-entry" role="listitem">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <small class="record-meta">${escapeHtml(occurredAt)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</small>
          </div>
          <div class="ledger-amounts">
            <span class="ledger-amount">${sign}₹${Math.abs(amount).toLocaleString("en-IN")}</span>
            ${balance}
          </div>
        </div>`;
    });
  };

  ledgerRequest.onsuccess = () => {
    entries = ledgerRequest.result;
    ledgerLoaded = true;
    render();
  };
  creditRequest.onsuccess = () => {
    credits = creditRequest.result;
    creditsLoaded = true;
    render();
  };

  tx.onerror = () => {
    statusBox.textContent = `Could not load customer ledger: ${tx.error ? tx.error.message : "IndexedDB error"}`;
  };
}

function getLedgerEntryTitle(type) {
  const titles = {
    opening: "Opening balance",
    credit: "Credit added",
    payment: "Payment received",
    adjustment: "Balance adjustment",
    cancel: "Credit canceled"
  };
  return titles[type] || "Account activity";
}

function downloadCustomerStatement() {
  if (!selectedCustomerStatement) return;

  const { name, entries, currentBalance } = selectedCustomerStatement;
  const rows = [
    ["Customer statement", name],
    ["Current balance", currentBalance],
    [],
    ["Date", "Activity", "Amount", "Balance after", "Details"]
  ];

  [...entries]
    .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt))
    .forEach((entry) => {
      const isNegative = entry.type === "payment" || entry.type === "cancel" ||
        (entry.type === "adjustment" && entry.amount < 0);
      rows.push([
        new Date(entry.occurredAt).toLocaleString(),
        getLedgerEntryTitle(entry.type),
        `${isNegative ? "-" : "+"}${Math.abs(entry.amount)}`,
        entry.balanceAfter === undefined ? "" : entry.balanceAfter,
        entry.note || ""
      ]);
    });

  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(csv, "text/csv;charset=utf-8", `bolkhata-statement-${dateStamp()}.csv`);
  statusBox.textContent = `Full customer statement for ${name} downloaded.`;
}

function shareCustomerStatement() {
  if (!selectedCustomerStatement) return;

  const { name, entries, currentBalance } = selectedCustomerStatement;
  const recentEntries = entries.slice(0, 10);
  const moreEntriesNote = entries.length > recentEntries.length
    ? `\nShowing the latest ${recentEntries.length} of ${entries.length} entries. Ask the shopkeeper for the full statement.`
    : "";
  const lines = [
    "*BolKhata customer statement*",
    `Customer: ${name}`,
    `Current balance: ₹${currentBalance.toLocaleString("en-IN")}`,
    "",
    ...recentEntries.map((entry) => {
      const amount = Number(entry.amount);
      const isNegative = entry.type === "payment" || entry.type === "cancel" ||
        (entry.type === "adjustment" && amount < 0);
      const date = new Date(entry.occurredAt).toLocaleDateString();
      return `${date} — ${getLedgerEntryTitle(entry.type)} ${isNegative ? "−" : "+"}₹${Math.abs(amount).toLocaleString("en-IN")}`;
    }),
    moreEntriesNote
  ].filter(Boolean);
  const message = lines.join("\n");

  if (!window.confirm(`Share ${name}'s current balance and recent account activity using WhatsApp?`)) {
    statusBox.textContent = "Customer statement sharing canceled.";
    return;
  }

  const link = document.createElement("a");
  link.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
  statusBox.textContent = "WhatsApp opened. Review the customer statement before sending it.";
}

function exportRecords(format) {
  readDatabaseSnapshot()
    .then((snapshot) => {
      if (format === "csv") {
        downloadFile(createCsv(snapshot), "text/csv;charset=utf-8", `bolkhata-records-${dateStamp()}.csv`);
        statusBox.textContent = "CSV records downloaded.";
      } else {
        downloadFile(JSON.stringify(snapshot, null, 2), "application/json", `bolkhata-backup-${dateStamp()}.json`);
        statusBox.textContent = "Backup downloaded. Keep it somewhere safe.";
      }
    })
    .catch((error) => {
      statusBox.textContent = `Export failed: ${error.message}`;
    });
}

function readDatabaseSnapshot() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readonly");
    const snapshot = {
      format: "BolKhataBackup",
      version: 1,
      exportedAt: new Date().toISOString()
    };

    storeNames.forEach((storeName) => {
      const getRequest = tx.objectStore(storeName).getAll();
      getRequest.onsuccess = () => {
        snapshot[storeName] = getRequest.result;
      };
      getRequest.onerror = () => reject(new Error(`Could not read ${storeName} for export.`));
    });

    tx.oncomplete = () => resolve(snapshot);
    tx.onerror = () => reject(new Error(tx.error ? tx.error.message : "Could not read local records."));
    tx.onabort = () => reject(new Error(tx.error ? tx.error.message : "Export was interrupted."));
  });
}

function createCsv(snapshot) {
  const rows = [["record_type", "customer", "item", "amount", "date", "details"]];
  snapshot.khata.forEach(({ name, amount }) => rows.push(["outstanding_balance", name, "", amount, "", "Current balance"]));
  snapshot.ledgerEntries.forEach((entry) => rows.push([
    entry.type,
    entry.name,
    "",
    entry.type === "payment" || entry.type === "cancel" ? -Math.abs(entry.amount) : entry.amount,
    entry.occurredAt,
    entry.balanceAfter === undefined ? (entry.note || "") : `Balance after: ${entry.balanceAfter}`
  ]));
  snapshot.orders.forEach(({ item, time }) => rows.push(["pending_supply", "", item, "", time, ""]));
  snapshot.deliveredOrders.forEach(({ item, deliveredAt }) => rows.push(["delivered_supply", "", item, "", deliveredAt, ""]));
  snapshot.paid.forEach(({ name, amount, paidAt }) => rows.push(["paid_credit", name, "", amount, paidAt, ""]));

  return rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  let text = String(value === undefined || value === null ? "" : value);
  if (typeof value === "string" && /^[\s]*[=+\-@]/.test(value)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadFile(contents, mimeType, fileName) {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function restoreBackupFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error("Backup files must be 10 MB or smaller.");
    }

    const backup = JSON.parse(await file.text());
    validateBackup(backup);
    if (!window.confirm("Restore this backup? It will replace all records currently saved on this device.")) {
      statusBox.textContent = "Restore canceled; current records were kept.";
      return;
    }

    await replaceDatabaseWithBackup(backup);
    statusBox.textContent = "Backup restored successfully.";
    renderAll();
  } catch (error) {
    statusBox.textContent = `Restore failed: ${error.message}`;
  } finally {
    backupFileInput.value = "";
  }
}

function validateBackup(backup) {
  if (!backup || typeof backup !== "object" || backup.format !== "BolKhataBackup" || backup.version !== 1) {
    throw new Error("This is not a supported BolKhata backup.");
  }
  if (!storeNames.every(name => Array.isArray(backup[name]) && backup[name].length <= 100000)) {
    throw new Error("The backup is missing valid record lists or contains too many records.");
  }

  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const isDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
  const isAmount = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const hasValidId = record => Number.isSafeInteger(record.id) && record.id > 0;
  const hasUniqueIds = records => new Set(records.map(record => record.id)).size === records.length;
  const types = new Set(["opening", "credit", "payment", "adjustment", "cancel"]);

  if (!backup.khata.every(record => isObject(record) && typeof record.name === "string" && record.name.trim() && isAmount(record.amount))) {
    throw new Error("The backup contains an invalid customer balance.");
  }
  if (!backup.orders.every(record => isObject(record) && hasValidId(record) && typeof record.item === "string" && record.item.trim() && typeof record.time === "string") ||
      !hasUniqueIds(backup.orders)) {
    throw new Error("The backup contains an invalid pending supply order.");
  }
  if (!backup.paid.every(record => isObject(record) && hasValidId(record) && typeof record.name === "string" && record.name.trim() && isAmount(record.amount) && isDate(record.paidAt)) ||
      !hasUniqueIds(backup.paid)) {
    throw new Error("The backup contains an invalid paid-credit record.");
  }
  if (!backup.deliveredOrders.every(record => isObject(record) && hasValidId(record) && typeof record.item === "string" && record.item.trim() && isDate(record.deliveredAt)) ||
      !hasUniqueIds(backup.deliveredOrders)) {
    throw new Error("The backup contains an invalid delivered order.");
  }
  if (!backup.ledgerEntries.every(record => isObject(record) && hasValidId(record) && typeof record.name === "string" &&
      record.name.trim() && types.has(record.type) && typeof record.amount === "number" && Number.isFinite(record.amount) &&
      isDate(record.occurredAt) && (record.balanceAfter === undefined || isAmount(record.balanceAfter))) ||
      !hasUniqueIds(backup.ledgerEntries)) {
    throw new Error("The backup contains an invalid customer-ledger entry.");
  }

  const customerNames = backup.khata.map(record => record.name);
  if (new Set(customerNames).size !== customerNames.length) {
    throw new Error("The backup contains duplicate customer balances.");
  }
}

function replaceDatabaseWithBackup(backup) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    storeNames.forEach((storeName) => {
      const store = tx.objectStore(storeName);
      store.clear();
      backup[storeName].forEach(record => store.put(record));
    });

    tx.oncomplete = resolve;
    tx.onerror = () => reject(new Error(tx.error ? tx.error.message : "Could not restore the backup."));
    tx.onabort = () => reject(new Error(tx.error ? tx.error.message : "Restore was interrupted."));
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function clearCredit(name, statusMessage = "Customer credit cleared.") {
  const tx = db.transaction(["khata", "ledgerEntries"], "readwrite");
  const creditStore = tx.objectStore("khata");
  const getRequest = creditStore.get(name);
  let creditFound = false;

  getRequest.onsuccess = () => {
    const credit = getRequest.result;
    if (credit) {
      creditFound = true;
      tx.objectStore("ledgerEntries").add({
        name,
        type: "cancel",
        amount: credit.amount,
        balanceAfter: 0,
        occurredAt: new Date().toISOString(),
        note: "Outstanding credit canceled."
      });
      creditStore.delete(name);
    }
  };

  tx.oncomplete = () => {
    editingCreditName = null;
    statusBox.textContent = creditFound ? statusMessage : "That customer credit record was not found.";
    renderAll();
  };
}

function markCreditPaid(name) {
  const tx = db.transaction(["khata", "paid", "ledgerEntries"], "readwrite");
  const creditStore = tx.objectStore("khata");
  const getRequest = creditStore.get(name);
  let creditFound = false;

  getRequest.onsuccess = () => {
    const credit = getRequest.result;
    if (credit) {
      creditFound = true;
      const paidAt = new Date().toISOString();
      tx.objectStore("paid").add({ ...credit, paidAt });
      tx.objectStore("ledgerEntries").add({
        name,
        type: "payment",
        amount: credit.amount,
        balanceAfter: 0,
        occurredAt: paidAt
      });
      creditStore.delete(name);
    }
  };

  tx.oncomplete = () => {
    editingCreditName = null;
    statusBox.textContent = creditFound
      ? `Credit for ${name} moved to Bahi Khata.`
      : "That customer credit record was not found.";
    renderAll();
  };
}

function renameCustomer(oldName, newName) {
  const selectedLedgerCustomerWasRenamed = ledgerCustomerSelect.value === oldName;
  const tx = db.transaction(["khata", "paid", "ledgerEntries"], "readwrite");
  const creditStore = tx.objectStore("khata");
  const oldCreditRequest = creditStore.get(oldName);
  const newCreditRequest = creditStore.get(newName);
  let oldCredit;
  let newCredit;
  let oldCreditLoaded = false;
  let newCreditLoaded = false;
  let mergedActiveBalance = false;

  const updateActiveBalance = () => {
    if (!oldCreditLoaded || !newCreditLoaded || !oldCredit) return;

    const newBalance = oldCredit.amount + (newCredit ? newCredit.amount : 0);
    mergedActiveBalance = Boolean(newCredit);
    creditStore.put({ name: newName, amount: newBalance });
    creditStore.delete(oldName);
  };

  oldCreditRequest.onsuccess = () => {
    oldCredit = oldCreditRequest.result;
    oldCreditLoaded = true;
    updateActiveBalance();
  };
  newCreditRequest.onsuccess = () => {
    newCredit = newCreditRequest.result;
    newCreditLoaded = true;
    updateActiveBalance();
  };

  tx.objectStore("paid").openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    if (cursor.value.name === oldName) {
      cursor.update({ ...cursor.value, name: newName });
    }
    cursor.continue();
  };

  const ledgerStore = tx.objectStore("ledgerEntries");
  const ledgerRows = [];
  let oldNameHasHistory = false;
  let newNameHasHistory = false;
  ledgerStore.openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      if (cursor.value.name === oldName || cursor.value.name === newName) {
        ledgerRows.push(cursor.value);
        if (cursor.value.name === oldName) oldNameHasHistory = true;
        if (cursor.value.name === newName) newNameHasHistory = true;
      }
      cursor.continue();
    } else {
      const mergedHistory = oldNameHasHistory && (newNameHasHistory || mergedActiveBalance);
      ledgerRows.forEach((entry) => {
        const updatedEntry = { ...entry, name: newName };
        if (mergedHistory) delete updatedEntry.balanceAfter;
        ledgerStore.put(updatedEntry);
      });
    }
  };

  tx.oncomplete = () => {
    editingPaidId = null;
    if (selectedLedgerCustomerWasRenamed) {
      const selectedOption = ledgerCustomerSelect.options[ledgerCustomerSelect.selectedIndex];
      if (selectedOption) {
        selectedOption.value = newName;
        selectedOption.textContent = newName;
      }
    }
    statusBox.textContent = mergedActiveBalance
      ? `Renamed ${oldName} to ${newName}; active balances were combined.`
      : `Renamed ${oldName} to ${newName} across customer records and history.`;
    renderAll();
  };
  tx.onabort = () => {
    statusBox.textContent = `Could not rename ${oldName}: ${tx.error ? tx.error.message : "The update was canceled."}`;
  };
}

function deleteOrder(id, statusMessage) {
  const tx = db.transaction("orders", "readwrite");
  tx.objectStore("orders").delete(id);
  tx.oncomplete = () => {
    editingOrderId = null;
    statusBox.textContent = statusMessage;
    renderAll();
  };
}

function markOrderDelivered(id) {
  const tx = db.transaction(["orders", "deliveredOrders"], "readwrite");
  const orderStore = tx.objectStore("orders");
  const getRequest = orderStore.get(id);
  let orderFound = false;

  getRequest.onsuccess = () => {
    const order = getRequest.result;
    if (order) {
      orderFound = true;
      tx.objectStore("deliveredOrders").add({ ...order, deliveredAt: new Date().toISOString() });
      orderStore.delete(id);
    }
  };

  tx.oncomplete = () => {
    statusBox.textContent = orderFound
      ? "Supply marked delivered and added to Delivered supplies."
      : "That supply order was not found.";
    renderAll();
  };
}
