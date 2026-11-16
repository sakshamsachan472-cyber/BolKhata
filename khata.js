// 1. Setup IndexedDB (Offline Storage)
let db;
const SUPABASE_URL = "https://hewfiybgrkdnkzgsuprn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_g-zqvP6Rj9bMtSGCNpUn5w_itGippJ0";
const DEFAULT_SPEECH_LANGUAGE = { locale: "hi-IN", label: "Hindi / Hinglish" };
const OPTIONAL_SPEECH_LANGUAGES = [
  { locale: "bn-IN", label: "बंगाली / Bengali (বাংলা)" },
  { locale: "gu-IN", label: "गुजराती / Gujarati (ગુજરાતી)" },
  { locale: "kn-IN", label: "कन्नड़ / Kannada (ಕನ್ನಡ)" },  
  { locale: "ml-IN", label: "मलयालम / Malayalam (മലയാളം)" },
  { locale: "mr-IN", label: "मराठी / Marathi" },
  { locale: "pa-IN", label: "पंजाबी / Punjabi (ਪੰਜਾਬੀ)" }, 
  { locale: "ta-IN", label: "तमिल / Tamil (தமிழ்)" },
  { locale: "te-IN", label: "तेलुगु / Telugu (తెలుగు)" }, 
  { locale: "ur-IN", label: "उर्दू / Urdu (اردو)" }
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
  statusBox.textContent = `स्थानीय डेटा नहीं खुला: ${errorMessage} / Could not open local data: ${errorMessage}`;
};

// 2. Voice Recognition Setup
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
const supportsOnDeviceSpeechRecognition = Boolean(
  recognition &&
  "processLocally" in recognition &&
  typeof SpeechRecognition.available === "function" &&
  typeof SpeechRecognition.install === "function"
);

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
const voiceReview = document.getElementById("voiceReview");
const voiceTranscript = document.getElementById("voiceTranscript");
const voiceReviewEntries = document.getElementById("voiceReviewEntries");
const voiceReviewError = document.getElementById("voiceReviewError");
const confirmVoiceEntriesButton = document.getElementById("confirmVoiceEntries");
const cancelVoiceEntriesButton = document.getElementById("cancelVoiceEntries");
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
let pendingVoiceResult = null;

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
    const confirmed = window.confirm(`${name} का ₹${control.dataset.creditAmount} बाकी व्हाट्सऐप पर भेजें? / Share this balance using WhatsApp?`);
    if (!confirmed) {
      statusBox.textContent = "व्हाट्सऐप रिमाइंडर रद्द / WhatsApp reminder canceled.";
      return;
    }

    const link = document.createElement("a");
    link.href = control.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
    statusBox.textContent = "व्हाट्सऐप खुला—भेजने से पहले संदेश जाँचें / WhatsApp opened—review before sending.";
  } else if (control.dataset.creditAction === "edit") {
    editingCreditName = name;
    renderAll();
  } else if (control.dataset.creditAction === "keep") {
    editingCreditName = null;
    statusBox.textContent = "बदलाव रद्द—उधार वही है / Edit canceled—the credit amount is unchanged.";
    renderAll();
  } else if (control.dataset.creditAction === "cancel") {
    clearCredit(name, "ग्राहक का उधार हटाया / Customer credit removed.");
  } else if (control.dataset.creditAction === "paid") {
    markCreditPaid(name);
  }
});

ledgerCustomerSelect.addEventListener("change", renderLedger);
downloadCustomerStatementButton.addEventListener("click", downloadCustomerStatement);
shareCustomerStatementButton.addEventListener("click", shareCustomerStatement);
confirmVoiceEntriesButton.addEventListener("click", applyPendingVoiceEntries);
cancelVoiceEntriesButton.addEventListener("click", () => {
  pendingVoiceResult = null;
  voiceReview.hidden = true;
  micBtn.disabled = false;
  statusBox.textContent = "आवाज़ की एंट्री रद्द / Voice entry canceled; nothing was saved.";
});

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
const guideDialog = document.getElementById("guideDialog");
document.getElementById("openGuideBtn").addEventListener("click", () => guideDialog.showModal());
document.getElementById("closeGuideBtn").addEventListener("click", () => guideDialog.close());
guideDialog.addEventListener("click", (event) => {
  if (event.target === guideDialog) guideDialog.close();
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
    statusBox.textContent = "शून्य से बड़ी सही रकम लिखें / Enter a valid amount greater than zero.";
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
    statusBox.textContent = creditFound
      ? `${name} का उधार ₹${amount} किया / Credit for ${name} updated to ₹${amount}.`
      : "ग्राहक का उधार नहीं मिला / Customer credit was not found.";
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
    statusBox.textContent = "नाम बदलना रद्द / Name edit canceled.";
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
    statusBox.textContent = "ग्राहक का नाम लिखें / Enter a customer name.";
    newNameInput.focus();
    return;
  }
  if (newName === oldName) {
    editingPaidId = null;
    statusBox.textContent = "ग्राहक का नाम नहीं बदला / Customer name is unchanged.";
    renderAll();
    return;
  }
  if (!window.confirm(`${oldName} का नाम ${newName} करें? इससे उधार और पूरा इतिहास बदलेगा। / Rename customer? This updates balances and history.`)) {
    statusBox.textContent = "नाम बदलना रद्द / Name change canceled.";
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
    statusBox.textContent = "बदलाव रद्द—ऑर्डर वही है / Edit canceled—the order is unchanged.";
    renderAll();
  } else if (button.dataset.orderAction === "cancel") {
    deleteOrder(id, "सप्लाई ऑर्डर रद्द / Supply order canceled.");
  } else if (button.dataset.orderAction === "done") {
    if (window.confirm("क्या यह सप्लाई डिलीवर हुई? / Was this supply delivered?")) {
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
    statusBox.textContent = "सेव करने से पहले सामान और मात्रा लिखें / Enter item and quantity before saving.";
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
    statusBox.textContent = orderFound
      ? "सप्लाई ऑर्डर बदल गया / Supply order updated."
      : "सप्लाई ऑर्डर नहीं मिला / Supply order was not found.";
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
  setSyncStatus(authMode === "signup" ? "खाता बन रहा है / Creating account..." : "लॉगिन हो रहा है / Signing in...");

  try {
    if (!navigator.onLine) throw new Error("लॉगिन या खाता बनाने के लिए इंटरनेट जोड़ें / Connect to sign in or create an account.");
    if (authMode === "signup" && (!fullName || !profession)) {
      throw new Error("अपना नाम और पेशा लिखें / Enter your name and profession.");
    }
    const result = await authRequest(
      authMode === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password",
      authMode === "signup"
        ? { email, password, data: { full_name: fullName, profession, additional_language: additionalLanguage } }
        : { email, password }
    );
    if (!result.access_token || !result.user) {
      setSyncStatus("खाता बना। ईमेल से पुष्टि करके यहाँ लॉगिन करें / Account created. Confirm your email, then sign in here.");
      return;
    }

    await acceptCloudSession(makeSession(result));
    form.reset();
  } catch (error) {
    setSyncStatus(`खाता अनुरोध पूरा नहीं हुआ: ${error.message} / Account request failed: ${error.message}`);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function populateAdditionalLanguageSelect(select, selectedLanguage) {
  select.replaceChildren(new Option("कोई अतिरिक्त भाषा नहीं / No extra language", ""));
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
  voiceLanguageSelect.replaceChildren(new Option(`हिंदी / Hinglish (डिफ़ॉल्ट / default)`, DEFAULT_SPEECH_LANGUAGE.locale));
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
  document.getElementById("authSubmitBtn").textContent = isSignup ? "खाता बनाएँ / Create account" : "लॉगिन / Sign in";
  document.getElementById("authModeToggle").textContent = isSignup
    ? "खाता है? लॉगिन करें / Have an account? Sign in"
    : "नए हैं? खाता बनाएँ / New? Create account";
  document.getElementById("accountDialogTitle").textContent = isSignup ? "खाता बनाएँ / Create account" : "लॉगिन / Login";
}

async function initializeCloudAccount() {
  let savedSession;
  try {
    savedSession = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
  } catch (error) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSyncStatus("सेव लॉगिन नहीं पढ़ा गया—फिर लॉगिन करें / Could not read saved login—sign in again.");
    return;
  }
  if (!savedSession || !savedSession.access_token || !savedSession.user) {
    setSyncStatus("लॉगिन नहीं—डेटा इसी डिवाइस पर सेव है / Signed out—data stays on this device.");
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
    setSyncStatus(`लॉगिन वापस नहीं मिला: ${error.message}। स्थानीय डेटा सुरक्षित है / Could not restore login: ${error.message}. Local data is safe.`);
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

function getBusinessProfession() {
  const profession = cloudSession && cloudSession.user.user_metadata
    ? cloudSession.user.user_metadata.profession
    : "";
  return typeof profession === "string" && profession.trim() ? profession.trim() : "my business";
}

async function acceptCloudSession(session, syncImmediately = true) {
  const boundAccount = localStorage.getItem(BOUND_ACCOUNT_KEY);
  if (boundAccount && boundAccount !== session.user.id) {
    throw new Error("इस डिवाइस का डेटा दूसरे खाते से जुड़ा है—पुराने खाते से लॉगिन करें / This device's data belongs to another account—sign in with that account.");
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
  document.getElementById("accountDialogTitle").textContent = "आपका खाता / Your account";
  document.getElementById("accountLabel").textContent = fullName
    ? `${fullName} — ${session.user.email} / लॉगिन है / Signed in`
    : `${session.user.email} / लॉगिन है / Signed in`;
  document.getElementById("openAccountBtn").textContent = "खाता / Account";

  if (!navigator.onLine) {
    setSyncStatus("लॉगिन है। ऑफ़लाइन बदलाव इसी डिवाइस पर सेव होंगे, इंटरनेट आने पर सिंक होंगे / Signed in. Offline changes save here and sync when connected.");
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
  document.getElementById("openAccountBtn").textContent = "लॉगिन / Login";
  document.getElementById("accountDialogTitle").textContent = "लॉगिन / Login";
  setAuthMode("signin");
  populateAdditionalLanguageSelect(profileSpeechLanguageSelect, "");
  updateVoiceLanguageOptions("");
  setSyncStatus("लॉगआउट हुआ—डेटा इसी डिवाइस पर रहेगा / Signed out—your data stays on this device.");
  if (session && navigator.onLine) {
    try {
      await authRequest("/auth/v1/logout", null, session.access_token);
    } catch (error) {
      setSyncStatus(`इस डिवाइस से लॉगआउट हुआ, सर्वर से नहीं: ${error.message} / Signed out here, but server sign-out failed: ${error.message}`);
    }
  }
}

async function saveProfileDetails(event) {
  event.preventDefault();
  if (!cloudSession) {
    setSyncStatus("जानकारी सेव करने के लिए लॉगिन करें / Sign in to save account details.");
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("जानकारी सेव करने के लिए इंटरनेट जोड़ें। खाता ऑफ़लाइन उपलब्ध है / Connect to save details; khata stays available offline.");
    return;
  }

  const form = event.currentTarget;
  const fullName = form.elements.namedItem("name").value.trim();
  const profession = form.elements.namedItem("profession").value.trim();
  const additionalLanguage = form.elements.namedItem("additional_language").value;
  const saveButton = document.getElementById("saveProfileBtn");
  if (!fullName || !profession) {
    setSyncStatus("अपना नाम और पेशा लिखें / Enter your name and profession.");
    return;
  }

  saveButton.disabled = true;
  setSyncStatus("खाते की जानकारी सेव हो रही है / Saving account details...");
  try {
    const updatedUser = await authRequest(
      "/auth/v1/user",
      { data: { full_name: fullName, profession, additional_language: additionalLanguage } },
      cloudSession.access_token,
      "PUT"
    );
    if (!updatedUser || updatedUser.id !== cloudSession.user.id) {
      throw new Error("सर्वर ने बदलाव की पुष्टि नहीं की / Server did not confirm the update.");
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
    document.getElementById("accountLabel").textContent = `${fullName} — ${cloudSession.user.email} / लॉगिन है / Signed in`;
    renderAll();
    setSyncStatus("खाते की जानकारी और भाषा सेव हुई / Account details and language saved.");
  } catch (error) {
    setSyncStatus(`जानकारी सेव नहीं हुई: ${error.message} / Could not save details: ${error.message}`);
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
    setSyncStatus("ऑफ़लाइन: बदलाव यहीं सेव होंगे, इंटरनेट आने पर सिंक होंगे / Offline: changes save here and sync when connected.");
    return;
  }

  cloudSyncInProgress = true;
  const syncButton = document.getElementById("syncNowBtn");
  syncButton.disabled = true;
  setSyncStatus(cloudReady ? "डेटा क्लाउड पर सिंक हो रहा है / Syncing data to cloud..." : "क्लाउड से जुड़ रहा है / Connecting to cloud...");
  const firstCloudSync = !cloudReady;

  try {
    if (cloudSession.expiresAt <= Date.now() + 60000) {
      if (!cloudSession.refresh_token) throw new Error("सेशन खत्म—फिर लॉगिन करें / Session expired—sign in again.");
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
    setSyncStatus(`${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} पर क्लाउड सिंक हुआ / Synced to cloud.`);
  } catch (error) {
    setSyncStatus(`क्लाउड सिंक नहीं हुआ: ${error.message}। स्थानीय डेटा सुरक्षित है / Cloud sync failed: ${error.message}. Local data is safe.`);
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

const ENGLISH_VOICE_NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000
};
const ROMAN_HINDI_VOICE_NUMBER_WORDS = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6,
  saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, bees: 20,
  tees: 30, chalis: 40, pachaas: 50, pachas: 50, pachhas: 50, saath: 60, sattar: 70,
  assi: 80, nabbe: 90, sau: 100, hazar: 1000, hazaar: 1000
};

function parseVoiceNumberWords(text, numberWords) {
  const words = text.toLocaleLowerCase("hi-IN").match(/[\p{L}\p{M}]+/gu) || [];
  let total = 0;
  let current = 0;
  let found = false;
  for (const word of words) {
    const value = numberWords[word];
    if (value === undefined) continue;
    found = true;
    if (value === 100) current = (current || 1) * 100;
    else if (value === 1000) {
      total += (current || 1) * 1000;
      current = 0;
    } else current += value;
  }
  return found ? total + current : 0;
}

function parseVoiceAmount(text) {
  const digits = normalizeIndianDigits(text).match(/\d+(?:\.\d+)?/);
  if (digits) return Number(digits[0]);
  if (/\b(?:dedh|derh)\s+sau\b/i.test(text)) return 150;
  return parseVoiceNumberWords(text, MULTILINGUAL_VOICE_NUMBER_WORDS);
}

const VOICE_COMMANDS_BY_LANGUAGE = {
  "bn-IN": {
    query: ["কত বাকি", "বাকি কত", "বকেয়া কত", "ব্যালেন্স কত"],
    payment: ["দিয়েছে", "দিয়েছেন", "দিল", "দিলেন", "জমা", "পরিশোধ", "পেমেন্ট", "টাকা দিয়েছে"],
    credit: ["ধার", "বাকিতে", "বাকি যোগ", "খাতায় লেখ", "লিখে রাখ"],
    stopWords: ["টাকা", "টাকায়", "রুপি", "রুপায়", "পয়সা", "কত", "হয়েছে", "হবে", "দাও", "দিয়ে", "নাম"]
  },
  "gu-IN": {
    query: ["કેટલું બાકી", "બાકી કેટલું", "બેલેન્સ કેટલું", "બાકી કેટલું છે"],
    payment: ["આપ્યા", "આપ્યું", "ચૂકવ્યા", "ચૂકવ્યું", "જમા", "ભર્યા", "ચુકવણી"],
    credit: ["ઉધાર", "બાકી ઉમેરો", "ખાતામાં લખો", "લખી લો"],
    stopWords: ["રૂપિયા", "રૂપિયો", "પૈસા", "કેટલું", "છે", "આપો", "નામ"]
  },
  "kn-IN": {
    query: ["ಎಷ್ಟು ಬಾಕಿ", "ಬಾಕಿ ಎಷ್ಟು", "ಬ್ಯಾಲೆನ್ಸ್ ಎಷ್ಟು"],
    payment: ["ಕೊಟ್ಟರು", "ಕೊಟ್ಟನು", "ನೀಡಿದರು", "ಪಾವತಿ", "ಪಾವತಿಸಿದರು", "ಜಮಾ", "ಕಟ್ಟಿದರು"],
    credit: ["ಸಾಲ", "ಬಾಕಿ ಸೇರಿಸಿ", "ಖಾತೆಗೆ ಬರೆಯಿರಿ", "ಬರೆದು ಕೊಳ್ಳಿ"],
    stopWords: ["ರೂಪಾಯಿ", "ರೂಪಾಯಿಗಳು", "ಹಣ", "ಎಷ್ಟು", "ಹೇಗೆ", "ಹೆಸರು", "ಗೆ", "ನೀಡಿ"]
  },
  "ml-IN": {
    query: ["എത്ര ബാക്കി", "ബാക്കി എത്ര", "ബാലൻസ് എത്ര"],
    payment: ["കൊടുത്തു", "നൽകി", "അടച്ചു", "പേയ്മെന്റ്", "പണം നൽകി", "ജമ"],
    credit: ["കടം", "ബാക്കി ചേർക്കുക", "എഴുതിവെക്കുക", "ഖാതയിൽ എഴുതുക"],
    stopWords: ["രൂപ", "രൂപയ്ക്ക്", "പൈസ", "എത്ര", "ആണ്", "പേര്", "എഴുതുക"]
  },
  "mr-IN": {
    query: ["किती बाकी", "बाकी किती", "शिल्लक किती", "बॅलन्स किती"],
    payment: ["दिले", "दिला", "भरले", "जमा", "चुकते केले", "पैसे दिले"],
    credit: ["उधार", "बाकी जोडा", "खात्यात लिहा", "लिहून ठेवा"],
    stopWords: ["रुपये", "रुपया", "रुपयांनी", "पैसे", "किती", "आहे", "नाव", "ला"]
  },
  "pa-IN": {
    query: ["ਕਿੰਨਾ ਬਾਕੀ", "ਕਿੰਨੀ ਬਾਕੀ", "ਬਾਕੀ ਕਿੰਨਾ", "ਬਕਾਇਆ ਕਿੰਨਾ"],
    payment: ["ਦੇ ਦਿੱਤੇ", "ਦਿੱਤੇ", "ਜਮ੍ਹਾ", "ਭੁਗਤਾਨ", "ਚੁਕਾਇਆ", "ਪੈਸੇ ਦਿੱਤੇ"],
    credit: ["ਉਧਾਰ", "ਬਾਕੀ ਜੋੜੋ", "ਖਾਤੇ ਵਿੱਚ ਲਿਖੋ", "ਲਿਖ ਲਵੋ"],
    stopWords: ["ਰੁਪਏ", "ਰੁਪਇਆ", "ਪੈਸੇ", "ਕਿੰਨਾ", "ਹੈ", "ਨਾਮ", "ਨੂੰ"]
  },
  "ta-IN": {
    query: ["எவ்வளவு பாக்கி", "பாக்கி எவ்வளவு", "நிலுவை எவ்வளவு"],
    payment: ["கொடுத்தார்", "செலுத்தினார்", "செலுத்தினேன்", "கட்டினார்", "பணம் கொடுத்தார்"],
    credit: ["கடன்", "பாக்கி சேர்க்கவும்", "கணக்கில் எழுதவும்", "எழுதி வைக்கவும்"],
    stopWords: ["ரூபாய்", "ரூபா", "பணம்", "எவ்வளவு", "ஆகிறது", "பெயர்", "கொடு"]
  },
  "te-IN": {
    query: ["ఎంత బాకీ", "బాకీ ఎంత", "బ్యాలెన్స్ ఎంత"],
    payment: ["ఇచ్చారు", "ఇచ్చాడు", "చెల్లించారు", "చెల్లించాడు", "కట్టారు", "జమ", "డబ్బులు ఇచ్చారు"],
    credit: ["అప్పు", "బాకీ జోడించండి", "ఖాతాలో రాయండి", "రాసి పెట్టండి"],
    stopWords: ["రూపాయలు", "రూపాయి", "డబ్బులు", "ఎంత", "ఉంది", "పేరు", "కు"]
  },
  "ur-IN": {
    query: ["کتنا باقی", "کتنی باقی", "باقی کتنا", "بقایا کتنا"],
    payment: ["دے دیے", "دیا", "ادا کیا", "جمع", "ادا", "رقم دی"],
    credit: ["ادھار", "باقی شامل", "کھاتے میں لکھو", "لکھ دیں"],
    stopWords: ["روپے", "روپیہ", "پیسے", "کتنا", "ہے", "نام", "کو"]
  }
};

function voiceCommandType(text, speechLocale = DEFAULT_SPEECH_LANGUAGE.locale) {
  const queryPhrases = ["how much", "balance", "kitna baki", "kitna baaki", "kitne baki", "kitne baaki",
    "baki kitna", "baaki kitna", "कितना बाकी", "कितने बाकी", "बाकी कितना", "बैलेंस", "हिसाब बताओ"];
  const paymentPhrases = ["paid", "payment", "received", "gave me", "paid me", "jama",
    "mil gaye", "mil gaya", "kaat do", "kaat lo", "दे दिए", "दे दिया",
    "जमा", "मिल गए", "मिल गया", "काट दो", "चुकाया"];
  const creditPhrases = ["udhar", "baki", "baaki", "credit", "owe", "add", "likho", "likh do", "jodo",
    "उधार", "बाकी", "लिखो", "जोड़ो"];
  const localizedCommands = VOICE_COMMANDS_BY_LANGUAGE[speechLocale];
  if (queryPhrases.some(phrase => text.includes(phrase)) ||
      (localizedCommands && localizedCommands.query.some(phrase => text.includes(phrase)))) return "query";
  if (localizedCommands && localizedCommands.payment.some(phrase => text.includes(phrase))) return "payment";
  if (localizedCommands && localizedCommands.credit.some(phrase => text.includes(phrase))) return "credit";
  if (/(?:\bko\b.*\b(?:diya|diye)\b|को.*(?:दिया|दिए))/u.test(text)) return "credit";
  if (/(?:\bne\b.*\b(?:diya|diye)\b|ने.*(?:दिया|दिए))/u.test(text)) return "payment";
  if (/\bde diye\b|\bde diya\b/u.test(text)) return "payment";
  if (paymentPhrases.some(phrase => text.includes(phrase))) return "payment";
  if (creditPhrases.some(phrase => text.includes(phrase))) return "credit";
  return localizedCommands ? null : "credit";
}

function voiceSegments(transcript, speechLocale = DEFAULT_SPEECH_LANGUAGE.locale) {
  const normalized = transcript.replace(/\b(hundred|thousand)\s+and\s+(?=[a-z])/giu, "$1 ");
  const localizedConnectors = {
    "bn-IN": ["এবং", "তারপর"],
    "gu-IN": ["અને", "પછી"],
    "kn-IN": ["ಮತ್ತು", "ನಂತರ"],
    "ml-IN": ["കൂടാതെ", "പിന്നെ"],
    "mr-IN": ["आणि", "नंतर"],
    "pa-IN": ["ਅਤੇ", "ਫਿਰ"],
    "ta-IN": ["மற்றும்", "பிறகு"],
    "te-IN": ["మరియు", "తర్వాత"],
    "ur-IN": ["اور", "پھر"]
  }[speechLocale] || [];
  const connectorPattern = localizedConnectors.length
    ? new RegExp(`[,;.!?]|\\b(?:and then|then|and|aur|phir)\\b|(?:और|फिर|उसके बाद|${localizedConnectors.join("|")})`, "giu")
    : /[,;.!?]|\b(?:and then|then|and|aur|phir)\b|(?:और|फिर|उसके बाद)/giu;
  return normalized.split(connectorPattern)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function extractVoiceCustomerName(segment, knownCustomers, speechLocale = DEFAULT_SPEECH_LANGUAGE.locale) {
  const knownMatch = [...knownCustomers]
    .sort((left, right) => right.length - left.length)
    .find(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{M}])${escaped}(?=$|[^\\p{L}\\p{M}])`, "iu").test(segment);
    });
  if (knownMatch) return knownMatch;

  const localizedCommands = VOICE_COMMANDS_BY_LANGUAGE[speechLocale];
  const localizedStopWords = localizedCommands
    ? [...localizedCommands.query, ...localizedCommands.payment, ...localizedCommands.credit, ...localizedCommands.stopWords]
      .flatMap(phrase => phrase.toLocaleLowerCase(speechLocale).match(/[\p{L}\p{M}]+/gu) || [])
    : [];
  const ignoredWords = new Set([
    ...Object.keys(hindiNumberWords),
    ...Object.keys(MULTILINGUAL_VOICE_NUMBER_WORDS),
    ...Object.keys(ENGLISH_VOICE_NUMBER_WORDS),
    ...Object.keys(ROMAN_HINDI_VOICE_NUMBER_WORDS),
    ...localizedStopWords,
    "dedh", "derh",
    "rupee", "rupees", "rs", "inr", "rupaye", "rupaya", "rupay", "paise", "paisa",
    "write", "add", "credit", "udhaar", "owe", "for", "to", "the", "customer",
    "paid", "payment", "received", "de", "diya", "diye", "ne", "dena", "jama", "mil", "gaye",
    "give", "gave", "and", "then", "how", "much", "balance", "is", "what", "check", "does", "me", "mujhe",
    "owes", "has",
    "likho", "likh", "do", "jodo", "ko", "ka", "ki", "ke", "ne", "hai", "batao",
    "kitna", "kitne", "baki", "baaki", "udhar", "द", "दिए", "दिया", "उधार", "बाकी",
    "रुपये", "रुपया", "रुपए", "पैसे", "जमा", "मिल", "मिला", "मिले", "गए", "गया", "काट", "दो",
    "दे", "ने",
    "कितना", "कितने", "है", "बता", "बताओ", "लिखो", "जोड़ो", "का", "की", "के", "को", "ने"
  ]);
  const words = segment.replace(/[^\p{L}\p{M}\s]/gu, " ").trim().split(/\s+/);
  const nameWords = words.filter(word => word && !ignoredWords.has(word.toLocaleLowerCase("hi-IN")));
  if (!nameWords.length) return null;
  return nameWords.map(word => word.charAt(0).toLocaleUpperCase("hi-IN") + word.slice(1)).join(" ");
}

const DEVANAGARI_CONSONANTS = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "ng", च: "ch", छ: "chh", ज: "j", झ: "jh",
  ञ: "ny", ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n", त: "t", थ: "th", द: "d",
  ध: "dh", न: "n", प: "p", फ: "ph", ब: "b", भ: "bh", म: "m", य: "y", र: "r",
  ल: "l", व: "v", श: "sh", ष: "sh", स: "s", ह: "h"
};
const DEVANAGARI_VOWELS = {
  अ: "a", आ: "aa", इ: "i", ई: "ii", उ: "u", ऊ: "uu", ऋ: "ri", ए: "e", ऐ: "ai",
  ओ: "o", औ: "au"
};
const DEVANAGARI_MATRAS = {
  "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au"
};

function canonicalizeVoiceName(name) {
  const characters = Array.from(name.toLocaleLowerCase("hi-IN"));
  let transliterated = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (DEVANAGARI_CONSONANTS[character]) {
      transliterated += DEVANAGARI_CONSONANTS[character];
      const next = characters[index + 1];
      if (next === "्") index += 1;
      else if (DEVANAGARI_MATRAS[next]) {
        transliterated += DEVANAGARI_MATRAS[next];
        index += 1;
      } else if (next === "ं" || next === "ँ") {
        transliterated += "an";
        index += 1;
      } else if (next && /[\p{L}\p{M}]/u.test(next)) transliterated += "a";
    } else if (DEVANAGARI_VOWELS[character]) transliterated += DEVANAGARI_VOWELS[character];
    else if (character === "ं" || character === "ँ") transliterated += "n";
    else if (character === "ः") transliterated += "h";
    else if (character !== "़" && character !== "्") transliterated += character;
  }
  return transliterated
    .replace(/aa/g, "a")
    .replace(/ii|ee/g, "i")
    .replace(/uu|oo/g, "u")
    .replace(/w/g, "v")
    .replace(/[^\p{L}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLocalVoiceTranscript(transcript, knownCustomers, speechLocale = DEFAULT_SPEECH_LANGUAGE.locale) {
  const segments = voiceSegments(transcript, speechLocale);
  if (!segments.length || segments.length > 20) {
    return {
      transcript,
      entries: [],
      needs_clarification: segments.length > 20
        ? "कृपया एक बार में 20 या उससे कम एंट्री बोलें। / Please speak 20 or fewer entries at a time."
        : "आवाज़ समझ नहीं आई। / No command was recognized."
    };
  }

  const knownNames = new Map(knownCustomers.map(name => [canonicalizeVoiceName(name), name]));
  const entries = segments.map(segment => {
    const type = voiceCommandType(segment.toLocaleLowerCase("hi-IN"), speechLocale);
    if (!type) {
      return {
        type: null,
        name: null,
        amount: null,
        item: null,
        qty: null,
        unit: null,
        status: "unrecognized_command",
        message: "कमांड समझ नहीं आई / Command not recognized. Use a supported credit, payment, or balance phrase."
      };
    }
    let name = extractVoiceCustomerName(segment, knownCustomers, speechLocale);
    const knownName = name ? knownNames.get(canonicalizeVoiceName(name)) : null;
    if (knownName) name = knownName;
    const amount = type === "query" ? null : parseVoiceAmount(segment);
    let status;
    let message;
    if (!name) {
      status = "no_name_found";
      message = "नाम नहीं मिला / No customer name found.";
    } else if (type !== "query" && (!Number.isFinite(amount) || amount <= 0)) {
      status = "no_amount_found";
      message = "सही रकम नहीं मिली / No valid amount found.";
    } else if (knownName) {
      status = "existing_customer";
    } else if (type === "credit") {
      status = "new_customer";
      message = `नया ग्राहक / New customer: ${name}`;
    } else {
      status = "customer_not_found";
      message = `ग्राहक खाता में नहीं मिला / ${name} is not in the khata.`;
    }
    return { type, name, amount, item: null, qty: null, unit: null, status, message };
  });

  return { transcript, entries, needs_clarification: null };
}

async function handleLocalVoiceTranscript(transcript, speechLocale) {
  const lower = normalizeIndianDigits(transcript).toLocaleLowerCase("hi-IN");
  const localizedSupplyWords = SUPPLY_WORDS_BY_LANGUAGE[speechLocale] || [];
  const hasProductQuantity = /\d+\s*(?:kg|g|grams?|lit(?:er|re)s?|packets?|किलो|किलोग्राम|लीटर|पैकेट|ग्राम)/i.test(lower);
  const isSupply = lower.includes("order") || lower.includes("milk") || lower.includes("sugar") ||
    lower.includes("tea") || lower.includes("peanut") || lower.includes("ऑर्डर") ||
    lower.includes("मंगवाओ") || lower.includes("दूध") || lower.includes("चीनी") ||
    lower.includes("चाय") || localizedSupplyWords.some(word => lower.includes(word)) || hasProductQuantity;
  if (isSupply) {
    processCommand(transcript, true, speechLocale);
    return;
  }
  const knownCustomers = await getKnownCustomerNames();
  showVoiceReview(parseLocalVoiceTranscript(transcript, knownCustomers, speechLocale));
}

function getKnownCustomerNames() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("khata", "readonly");
    const request = tx.objectStore("khata").getAll();
    request.onsuccess = () => resolve(request.result.map(record => record.name));
    request.onerror = () => reject(new Error("Could not read existing customer names."));
    tx.onerror = () => reject(new Error(tx.error ? tx.error.message : "Could not read the khata."));
  });
}

function isApplicableVoiceEntry(entry) {
  if (!entry || !["existing_customer", "new_customer"].includes(entry.status) ||
      !["credit", "payment", "query"].includes(entry.type) ||
      typeof entry.name !== "string" || !entry.name.trim()) return false;
  if (entry.type === "query") return entry.status === "existing_customer";
  return Number.isFinite(entry.amount) && entry.amount > 0;
}

function showVoiceReview(result) {
  if (!result || typeof result.transcript !== "string" || !Array.isArray(result.entries)) {
    throw new Error("The voice parser returned an invalid result.");
  }
  pendingVoiceResult = result;
  voiceTranscript.textContent = `सुना / Heard: “${result.transcript}”`;
  voiceReviewEntries.replaceChildren();
  result.entries.forEach(entry => {
    const item = document.createElement("li");
    if (entry && entry.type === "query") {
      item.textContent = `Balance query / बाकी पूछें: ${entry.name || "नाम नहीं मिला / no name"}`;
    } else if (entry && entry.type === null) {
      item.textContent = "Command not recognized / कमांड समझ नहीं आई";
    } else {
      const action = entry && entry.type === "payment" ? "Payment / भुगतान" : "Credit / उधार";
      const amount = entry && Number.isFinite(entry.amount) ? `₹${entry.amount}` : "रकम नहीं मिली / amount missing";
      item.textContent = `${action}: ${entry && entry.name ? entry.name : "नाम नहीं मिला / no name"} — ${amount}`;
    }
    if (!isApplicableVoiceEntry(entry)) item.textContent += ` — ${entry && entry.message ? entry.message : "Please clarify this entry."}`;
    voiceReviewEntries.append(item);
  });

  const entries = result.entries;
  const blockedEntry = entries.length === 0 || entries.some(entry => !isApplicableVoiceEntry(entry));
  const clarification = typeof result.needs_clarification === "string" && result.needs_clarification.trim();
  confirmVoiceEntriesButton.disabled = blockedEntry || Boolean(clarification);
  voiceReviewError.hidden = !blockedEntry && !clarification;
  voiceReviewError.textContent = clarification
    ? `${result.needs_clarification} / कुछ साफ़ नहीं है—कृपया टेक्स्ट से सही करें या फिर बोलें। / Please clarify or record again.`
    : blockedEntry
      ? "कुछ एंट्री साफ़ नहीं है। इन्हें सेव नहीं किया गया—कृपया टेक्स्ट से सही करें या फिर बोलें। / Some entries are unclear and won't be saved. Correct them by typing or record again."
      : "";
  voiceReview.hidden = false;
  micBtn.disabled = true;
  statusBox.textContent = "एंट्री जाँचें—पुष्टि करने से पहले कुछ भी सेव नहीं होगा। / Review entries; nothing is saved until you confirm.";
  voiceReview.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function applyPendingVoiceEntries() {
  if (!pendingVoiceResult || !pendingVoiceResult.entries.every(isApplicableVoiceEntry)) return;
  confirmVoiceEntriesButton.disabled = true;
  cancelVoiceEntriesButton.disabled = true;
  applyVoiceEntries(pendingVoiceResult.entries)
    .then(results => {
      pendingVoiceResult = null;
      voiceReview.hidden = true;
      micBtn.disabled = false;
      statusBox.textContent = results.map(result => result.message).join(" ");
      if (results.length) speakBack(results.map(result => result.speech).join(". "));
      renderAll();
    })
    .catch(error => {
      statusBox.textContent = `एंट्री सेव नहीं हुई: ${error.message} / Voice entries were not saved: ${error.message}`;
    })
    .finally(() => {
      confirmVoiceEntriesButton.disabled = false;
      cancelVoiceEntriesButton.disabled = false;
    });
}

function applyVoiceEntries(entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["khata", "ledgerEntries", "paid"], "readwrite");
    const creditStore = tx.objectStore("khata");
    const ledgerStore = tx.objectStore("ledgerEntries");
    const paidStore = tx.objectStore("paid");
    const results = [];
    let index = 0;
    let failure = null;

    const abort = message => {
      failure = new Error(message);
      try {
        tx.abort();
      } catch {
        reject(failure);
      }
    };

    const processNext = () => {
      if (index >= entries.length) return;
      const entry = entries[index++];
      const getRequest = creditStore.get(entry.name);
      getRequest.onerror = () => abort("Could not read the customer's current balance.");
      getRequest.onsuccess = () => {
        const currentRecord = getRequest.result;
        const currentBalance = currentRecord ? Number(currentRecord.amount) : 0;
        if (entry.type === "query") {
          if (!currentRecord) {
            abort(`${entry.name} is no longer in the khata.`);
            return;
          }
          results.push({
            message: `${entry.name} का बाकी ₹${currentBalance} है। / ${entry.name}'s balance is ₹${currentBalance}.`,
            speech: `${entry.name}'s balance is ${currentBalance} rupees`
          });
          processNext();
          return;
        }

        const amount = Number(entry.amount);
        const occurredAt = new Date().toISOString();
        let balanceAfter;
        if (entry.type === "credit") {
          balanceAfter = currentBalance + amount;
          creditStore.put({ name: entry.name, amount: balanceAfter });
          results.push({
            message: `${entry.name} का कुल बाकी ₹${balanceAfter} है। / Added ₹${amount}; ${entry.name}'s total balance is ₹${balanceAfter}.`,
            speech: `${entry.name}'s total balance is ${balanceAfter} rupees`
          });
        } else {
          if (!currentRecord) {
            abort(`${entry.name} is no longer in the khata.`);
            return;
          }
          if (amount > currentBalance) {
            abort(`${entry.name} का बाकी ₹${currentBalance} है—₹${amount} भुगतान उससे ज़्यादा है। / ${entry.name}'s balance is ₹${currentBalance}, less than the ₹${amount} payment.`);
            return;
          }
          balanceAfter = currentBalance - amount;
          if (balanceAfter === 0) creditStore.delete(entry.name);
          else creditStore.put({ name: entry.name, amount: balanceAfter });
          paidStore.add({ name: entry.name, amount, paidAt: occurredAt });
          results.push({
            message: `${entry.name} का ₹${amount} भुगतान जोड़ा; अब बाकी ₹${balanceAfter} है। / Recorded ₹${amount} payment; ${entry.name}'s balance is now ₹${balanceAfter}.`,
            speech: `${entry.name}'s balance is now ${balanceAfter} rupees`
          });
        }
        ledgerStore.add({
          name: entry.name,
          type: entry.type === "credit" ? "credit" : "payment",
          amount,
          balanceAfter,
          occurredAt,
          note: "Browser voice entry confirmed by user."
        });
        processNext();
      };
    };

    tx.oncomplete = () => resolve(results);
    tx.onerror = () => {
      if (!failure) failure = new Error(tx.error ? tx.error.message : "Could not save the voice entries.");
    };
    tx.onabort = () => reject(failure || new Error(tx.error ? tx.error.message : "Saving voice entries was interrupted."));
    processNext();
  });
}

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
    handleLocalVoiceTranscript(transcript, recognition.lang).catch(error => {
      statusBox.textContent = `आवाज़ की एंट्री नहीं बनी: ${error.message} / Could not parse voice entry: ${error.message}`;
    });
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

async function startListening() {
  isListening = true;
  setMicButton(true);
  micBtn.disabled = true;
  recognition.lang = voiceLanguageSelect.value;
  let processingNotice = "";

  try {
    if (supportsOnDeviceSpeechRecognition) {
      statusBox.textContent = "डिवाइस पर आवाज़ की सुविधा जाँच रहे हैं… / Checking on-device speech availability…";
      const availability = await SpeechRecognition.available({
        langs: [recognition.lang],
        processLocally: true
      });

      if (availability === "available") {
        recognition.processLocally = true;
      } else if (availability === "downloadable" || availability === "downloading") {
        if (!navigator.onLine) {
          throw new Error("इस भाषा का offline speech pack डाउनलोड करना होगा। इंटरनेट से एक बार डाउनलोड करके फिर offline बोलें / This language pack needs a one-time download. Connect once to download it, then use speech offline.");
        }
        statusBox.textContent = "ऑफलाइन आवाज़ की भाषा डाउनलोड हो रही है… / Downloading the offline speech language pack…";
        const installed = await SpeechRecognition.install({
          langs: [recognition.lang],
          processLocally: true
        });
        if (!installed) throw new Error("भाषा pack डाउनलोड नहीं हुआ। / The offline speech language pack could not be installed.");
        recognition.processLocally = true;
      } else if (!navigator.onLine) {
        throw new Error("इस browser में चुनी भाषा की offline speech सुविधा उपलब्ध नहीं है। Internet से जुड़ें या लिखकर जोड़ें / Offline speech for this language is unavailable in this browser. Connect to the internet or type the entry.");
      } else {
        recognition.processLocally = false;
        processingNotice = "स्थानीय pack नहीं मिला; browser की online speech सुविधा इस्तेमाल होगी। / Offline pack unavailable; using the browser's online speech service.";
      }
    } else if (!navigator.onLine) {
      throw new Error("इस browser में offline speech सुविधा उपलब्ध नहीं है। Internet से जुड़ें या लिखकर जोड़ें / Offline speech isn't supported by this browser. Connect to the internet or type the entry.");
    } else {
      processingNotice = "इस browser में offline speech समर्थित नहीं; browser online speech सेवा इस्तेमाल करेगा। / Offline speech isn't supported here; using the browser's online speech service.";
    }

    micBtn.disabled = false;
    statusBox.textContent = `${getSpeechLanguage(recognition.lang).label} में बोलें। रोकने के लिए फिर दबाएँ। / Speak now; tap again to stop. ${processingNotice}`;
    recognition.start();
  } catch (error) {
    isListening = false;
    micBtn.disabled = false;
    setMicButton(false);
    statusBox.textContent = `आवाज़ शुरू नहीं हुई / Could not start voice input: ${error.message}`;
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
      statusBox.textContent = "कल की सप्लाई में जोड़ा / Added to tomorrow's supply.";
      if (useVoiceConfirmation) speakBack("Kal ki supply mein joda. Added to tomorrow's supply.");
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
    let balanceAfter = amount;

    getReq.onsuccess = () => {
      const existing = getReq.result ? getReq.result.amount : 0;
      balanceAfter = existing + amount;
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
      statusBox.textContent = `${customerName} का कुल बाकी ₹${balanceAfter} / Added ₹${amount}; ${customerName}'s total balance is now ₹${balanceAfter}.`;
      if (useVoiceConfirmation) speakBack(`${customerName} ka kul baki ${balanceAfter} rupaye hai. ${customerName}'s total balance is now ${balanceAfter} rupees.`);
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

const LOCALIZED_VOICE_NUMBER_WORDS = {
  "bn-IN": {
    "এক": 1, "দুই": 2, "তিন": 3, "চার": 4, "পাঁচ": 5, "ছয়": 6, "ছয়": 6, "সাত": 7, "আট": 8, "নয়": 9, "নয়": 9,
    "দশ": 10, "এগারো": 11, "বারো": 12, "তেরো": 13, "চৌদ্দ": 14, "পনেরো": 15, "ষোল": 16, "সতেরো": 17,
    "আঠারো": 18, "উনিশ": 19, "বিশ": 20, "ত্রিশ": 30, "চল্লিশ": 40, "পঞ্চাশ": 50, "ষাট": 60, "সত্তর": 70,
    "আশি": 80, "নব্বই": 90, "একশো": 100, "শত": 100, "হাজার": 1000
  },
  "gu-IN": {
    "એક": 1, "બે": 2, "ત્રણ": 3, "ચાર": 4, "પાંચ": 5, "છ": 6, "સાત": 7, "આઠ": 8, "નવ": 9, "દસ": 10,
    "અગિયાર": 11, "બાર": 12, "તેર": 13, "ચૌદ": 14, "પંદર": 15, "સોળ": 16, "સત્તર": 17, "અઢાર": 18,
    "ઓગણીસ": 19, "વીસ": 20, "ત્રીસ": 30, "ચાલીસ": 40, "પચાસ": 50, "સાઠ": 60, "સિત્તેર": 70, "એંસી": 80,
    "નેવું": 90, "સો": 100, "હજાર": 1000
  },
  "kn-IN": {
    "ಒಂದು": 1, "ಎರಡು": 2, "ಮೂರು": 3, "ನಾಲ್ಕು": 4, "ಐದು": 5, "ಆರು": 6, "ಏಳು": 7, "ಎಂಟು": 8, "ಒಂಬತ್ತು": 9,
    "ಹತ್ತು": 10, "ಹನ್ನೊಂದು": 11, "ಹನ್ನೆರಡು": 12, "ಹದಿಮೂರು": 13, "ಹದಿನಾಲ್ಕು": 14, "ಹದಿನೈದು": 15, "ಹದಿನಾರು": 16,
    "ಹದಿನೇಳು": 17, "ಹದಿನೆಂಟು": 18, "ಹತ್ತೊಂಬತ್ತು": 19, "ಇಪ್ಪತ್ತು": 20, "ಮೂವತ್ತು": 30, "ನಲವತ್ತು": 40,
    "ಐವತ್ತು": 50, "ಅರವತ್ತು": 60, "ಎಪ್ಪತ್ತು": 70, "ಎಂಬತ್ತು": 80, "ತೊಂಬತ್ತು": 90, "ನೂರು": 100, "ಸಾವಿರ": 1000
  },
  "ml-IN": {
    "ഒന്ന്": 1, "രണ്ട്": 2, "മൂന്ന്": 3, "നാല്": 4, "അഞ്ച്": 5, "ആറ്": 6, "ഏഴ്": 7, "എട്ട്": 8, "ഒമ്പത്": 9,
    "പത്ത്": 10, "പതിനൊന്ന്": 11, "പന്ത്രണ്ട്": 12, "പതിമൂന്ന്": 13, "പതിനാല്": 14, "പതിനഞ്ച്": 15,
    "പതിനാറ്": 16, "പതിനേഴ്": 17, "പതിനെട്ട്": 18, "പത്തൊമ്പത്": 19, "ഇരുപത്": 20, "മുപ്പത്": 30,
    "നാല്പത്": 40, "അൻപത്": 50, "അമ്പത്": 50, "അറുപത്": 60, "എഴുപത്": 70, "എൺപത്": 80, "തൊണ്ണൂറ്": 90,
    "നൂറ്": 100, "നൂറു": 100, "ആയിരം": 1000
  },
  "mr-IN": {
    "एक": 1, "दोन": 2, "तीन": 3, "चार": 4, "पाच": 5, "सहा": 6, "सात": 7, "आठ": 8, "नऊ": 9,
    "दहा": 10, "अकरा": 11, "बारा": 12, "तेरा": 13, "चौदा": 14, "पंधरा": 15, "सोळा": 16, "सतरा": 17,
    "अठरा": 18, "एकोणीस": 19, "वीस": 20, "तीस": 30, "चाळीस": 40, "पन्नास": 50, "साठ": 60, "सत्तर": 70,
    "ऐंशी": 80, "नव्वद": 90, "शंभर": 100, "हजार": 1000
  },
  "pa-IN": {
    "ਇੱਕ": 1, "ਇਕ": 1, "ਦੋ": 2, "ਤਿੰਨ": 3, "ਚਾਰ": 4, "ਪੰਜ": 5, "ਛੇ": 6, "ਸੱਤ": 7, "ਅੱਠ": 8, "ਨੌਂ": 9,
    "ਨੌ": 9, "ਦਸ": 10, "ਗਿਆਰਾਂ": 11, "ਬਾਰਾਂ": 12, "ਤੇਰਾਂ": 13, "ਚੌਦਾਂ": 14, "ਪੰਦਰਾਂ": 15, "ਸੋਲਾਂ": 16,
    "ਸਤਾਰਾਂ": 17, "ਅਠਾਰਾਂ": 18, "ਉੱਨੀ": 19, "ਵੀਹ": 20, "ਤੀਹ": 30, "ਚਾਲੀ": 40, "ਪੰਜਾਹ": 50, "ਸੱਠ": 60,
    "ਸੱਤਰ": 70, "ਅੱਸੀ": 80, "ਨੱਬੇ": 90, "ਸੌ": 100, "ਹਜ਼ਾਰ": 1000, "ਹਜਾਰ": 1000
  },
  "ta-IN": {
    "ஒன்று": 1, "ஒரு": 1, "இரண்டு": 2, "மூன்று": 3, "நான்கு": 4, "ஐந்து": 5, "ஆறு": 6, "ஏழு": 7, "எட்டு": 8,
    "ஒன்பது": 9, "பத்து": 10, "பதினொன்று": 11, "பன்னிரண்டு": 12, "பதின்மூன்று": 13, "பதினான்கு": 14,
    "பதினைந்து": 15, "பதினாறு": 16, "பதினேழு": 17, "பதினெட்டு": 18, "பத்தொன்பது": 19, "இருபது": 20,
    "முப்பது": 30, "நாற்பது": 40, "ஐம்பது": 50, "அறுபது": 60, "எழுபது": 70, "எண்பது": 80, "தொண்ணூறு": 90,
    "நூறு": 100, "ஆயிரம்": 1000
  },
  "te-IN": {
    "ఒకటి": 1, "ఒక": 1, "రెండు": 2, "మూడు": 3, "నాలుగు": 4, "ఐదు": 5, "ఆరు": 6, "ఏడు": 7, "ఎనిమిది": 8,
    "తొమ్మిది": 9, "పది": 10, "పదకొండు": 11, "పన్నెండు": 12, "పదమూడు": 13, "పద్నాలుగు": 14, "పదిహేను": 15,
    "పదహారు": 16, "పదిహేడు": 17, "పద్దెనిమిది": 18, "పంతొమ్మిది": 19, "ఇరవై": 20, "ముప్పై": 30, "నలభై": 40,
    "యాభై": 50, "అరవై": 60, "డెబ్బై": 70, "ఎనభై": 80, "తొంభై": 90, "వంద": 100, "వెయ్యి": 1000, "వేయి": 1000
  },
  "ur-IN": {
    "ایک": 1, "دو": 2, "تین": 3, "چار": 4, "پانچ": 5, "چھ": 6, "سات": 7, "آٹھ": 8, "اٹھ": 8, "نو": 9, "دس": 10,
    "گیارہ": 11, "بارہ": 12, "تیرہ": 13, "چودہ": 14, "پندرہ": 15, "سولہ": 16, "سترہ": 17, "اٹھارہ": 18,
    "انیس": 19, "بیس": 20, "تیس": 30, "چالیس": 40, "پچاس": 50, "ساٹھ": 60, "ستر": 70, "اسی": 80,
    "نوے": 90, "سو": 100, "سَو": 100, "ہزار": 1000
  }
};

const MULTILINGUAL_VOICE_NUMBER_WORDS = {
  ...ENGLISH_VOICE_NUMBER_WORDS,
  ...ROMAN_HINDI_VOICE_NUMBER_WORDS,
  ...hindiNumberWords,
  ...Object.assign({}, ...Object.values(LOCALIZED_VOICE_NUMBER_WORDS))
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
      const message = `Hi ${name}, your outstanding credit with ${getBusinessProfession()} is ₹${amount}. Please let me know when you've paid. Thank you.`;
      const whatsappLink = `https://wa.me/?text=${encodeURIComponent(message)}`;

      if (editingCreditName === name) {
        khataDiv.innerHTML += `
          <div class="card credit-card" role="listitem">
            <form class="credit-edit-form" data-credit-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)} का उधार बदलें / Edit credit for ${escapeHtml(name)}">
              <div class="credit-edit-main">
                <strong>${escapeHtml(name)}</strong>
                <div class="credit-edit-fields">
                  <label class="sr-only" for="credit-amount-${escapeHtml(name)}">रकम बदलें / Edit amount</label>
                  <input id="credit-amount-${escapeHtml(name)}" name="amount" class="credit-edit-input" type="number" min="1" step="1" value="${amount}" required />
                </div>
              </div>
              <div class="credit-edit-actions">
                <button class="btn-small btn-save" type="submit">सेव / Save</button>
                <button class="btn-small btn-clear" type="button" data-credit-action="keep" data-credit-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)} की मौजूदा रकम रखें / Keep current amount for ${escapeHtml(name)}">रकम रखें / Keep</button>
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
              <a href="${whatsappLink}" class="btn-small btn-whatsapp" target="_blank" rel="noopener noreferrer" data-credit-action="share" data-credit-name="${escapeHtml(name)}" data-credit-amount="${amount}" aria-label="${escapeHtml(name)} का उधार व्हाट्सऐप पर भेजें / Share credit for ${escapeHtml(name)} on WhatsApp">व्हाट्सऐप / WhatsApp</a>
              <button class="btn-small btn-edit" type="button" data-credit-action="edit" data-credit-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)} का उधार बदलें / Edit credit for ${escapeHtml(name)}">बदलें / Edit</button>
              <button class="btn-small btn-cancel" type="button" data-credit-action="cancel" data-credit-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)} का उधार हटाएँ / Cancel credit for ${escapeHtml(name)}">रद्द / Cancel</button>
              <button class="btn-small btn-clear" type="button" data-credit-action="paid" data-credit-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)} का उधार चुकाया दिखाएँ / Mark credit for ${escapeHtml(name)} as paid">चुकाया / Paid</button>
            </div>
          </div>`;
      }
      cursor.continue();
    } else if (!hasCredits) {
      khataDiv.innerHTML = '<div class="empty-state" role="listitem">अभी कोई उधार बाकी नहीं / No outstanding customer credits.</div>';
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
                  <label class="sr-only" for="paid-customer-${id}">ग्राहक का नाम सही करें / Correct customer name</label>
                  <input id="paid-customer-${id}" name="name" class="paid-name-input" type="text" value="${escapeHtml(name)}" required autofocus />
                  <small class="record-meta">₹${amount} · चुकाया / Paid ${escapeHtml(paidDate)}</small>
                </div>
                <div class="paid-credit-actions">
                  <button class="btn-small btn-save" type="submit">नाम सेव / Save name</button>
                  <button class="btn-small btn-clear" type="button" data-paid-action="cancel-name" data-paid-id="${id}">रद्द / Cancel</button>
                </div>
              </form>
            </div>`;
        } else {
          paidList.innerHTML += `
            <div class="card paid-credit-card" role="listitem">
              <div class="paid-credit-main"><strong>${escapeHtml(name)}</strong><small class="record-meta">चुकाया / Paid ${escapeHtml(paidDate)}</small></div>
              <div class="paid-credit-actions">
                <span class="amount">₹${amount}</span>
                <button class="btn-small btn-edit" type="button" data-paid-action="edit-name" data-paid-id="${id}" aria-label="${escapeHtml(name)} का नाम बदलें / Edit customer name">नाम बदलें / Edit name</button>
              </div>
            </div>`;
        }
        cursor.continue();
      } else if (!hasPaidCredits) {
        paidList.innerHTML = '<div class="empty-state" role="listitem">चुकाया उधार यहाँ दिखेगा / Paid credits will appear here.</div>';
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
            <form class="order-edit-form" data-order-id="${id}" aria-label="सप्लाई ऑर्डर बदलें ${id} / Edit supply order ${id}">
              <label class="sr-only" for="order-item-${id}">सामान या मात्रा बदलें / Change item or quantity</label>
              <input id="order-item-${id}" name="item" class="order-edit-input" value="${escapeHtml(item)}" required />
              <div class="order-edit-actions">
                <button class="btn-small btn-save" type="submit">सेव / Save</button>
                <button class="btn-small btn-clear" type="button" data-order-action="keep" data-order-id="${id}" aria-label="मौजूदा सप्लाई रखें / Keep current supply order: ${escapeHtml(item)}">ऑर्डर रखें / Keep order</button>
              </div>
            </form>
          </div>`;
      } else {
        orderList.innerHTML += `
        <div class="card" role="listitem">
          <div class="order-description">${escapeHtml(item)} <small class="record-meta">(${time})</small></div>
          <div class="order-actions">
            <button class="btn-small btn-edit" type="button" data-order-action="edit" data-order-id="${id}" aria-label="सप्लाई बदलें / Edit supply: ${escapeHtml(item)}">बदलें / Edit</button>
            <button class="btn-small btn-cancel" type="button" data-order-action="cancel" data-order-id="${id}" aria-label="सप्लाई रद्द करें / Cancel supply: ${escapeHtml(item)}">रद्द / Cancel</button>
            <button class="btn-small btn-clear" type="button" data-order-action="done" data-order-id="${id}" aria-label="सप्लाई डिलीवर दिखाएँ / Mark supply delivered: ${escapeHtml(item)}">हो गया / Done</button>
          </div>
        </div>`;
      }
      cursor.continue();
    } else if (!hasOrders) {
      orderList.innerHTML = '<div class="empty-state" role="listitem">अभी कोई सप्लाई ऑर्डर नहीं / No supply orders yet.</div>';
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
          <small class="record-meta">डिलीवर / Delivered ${escapeHtml(deliveryDate)}</small>
        </div>`;
      cursor.continue();
    } else if (!hasDeliveredOrders) {
      deliveredList.innerHTML = '<div class="empty-state" role="listitem">डिलीवर ऑर्डर यहाँ दिखेंगे / Delivered orders appear here.</div>';
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
    statusBox.textContent = `आज का हिसाब अपडेट नहीं हुआ: ${tx.error ? tx.error.message : "IndexedDB error"} / Could not update today's summary.`;
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
      ledgerList.innerHTML = `<div class="empty-state" role="listitem">${names.length ? "हिसाब देखने के लिए ग्राहक चुनें / Choose a customer to view ledger." : "लेन-देन का इतिहास यहाँ दिखेगा / Transaction history appears here."}</div>`;
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
        ? `<small class="record-meta">बाकी / Balance: ₹${Number(entry.balanceAfter).toLocaleString("en-IN")}</small>`
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
    statusBox.textContent = `ग्राहक का हिसाब लोड नहीं हुआ: ${tx.error ? tx.error.message : "IndexedDB error"} / Could not load customer ledger.`;
  };
}

function getLedgerEntryTitle(type) {
  const titles = {
    opening: "शुरुआती बाकी / Opening balance",
    credit: "उधार जोड़ा / Credit added",
    payment: "भुगतान मिला / Payment received",
    adjustment: "बाकी रकम बदली / Balance adjusted",
    cancel: "उधार रद्द / Credit canceled"
  };
  return titles[type] || "खाते की एंट्री / Account activity";
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
  statusBox.textContent = `${name} का पूरा हिसाब डाउनलोड हुआ / Full statement for ${name} downloaded.`;
}

function shareCustomerStatement() {
  if (!selectedCustomerStatement) return;

  const { name, entries, currentBalance } = selectedCustomerStatement;
  const profession = getBusinessProfession();
  const recentEntries = entries.slice(0, 10);
  const moreEntriesNote = entries.length > recentEntries.length
    ? `\nआखिरी ${recentEntries.length} में से ${entries.length} एंट्री। पूरे हिसाब के लिए ${profession} से पूछें। / Showing latest ${recentEntries.length} of ${entries.length}; contact ${profession} for the full statement.`
    : "";
  const lines = [
    "*BolKhata customer statement*",
    `ग्राहक / Customer: ${name}`,
    `बाकी / Balance: ₹${currentBalance.toLocaleString("en-IN")}`,
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

  if (!window.confirm(`${name} का बाकी और हाल का हिसाब व्हाट्सऐप पर भेजें? / Share ${name}'s balance and recent activity on WhatsApp?`)) {
    statusBox.textContent = "हिसाब भेजना रद्द / Statement sharing canceled.";
    return;
  }

  const link = document.createElement("a");
  link.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
  statusBox.textContent = "व्हाट्सऐप खुला—हिसाब भेजने से पहले जाँचें / WhatsApp opened—review before sending.";
}

function exportRecords(format) {
  readDatabaseSnapshot()
    .then((snapshot) => {
      if (format === "csv") {
        downloadFile(createCsv(snapshot), "text/csv;charset=utf-8", `bolkhata-records-${dateStamp()}.csv`);
        statusBox.textContent = "CSV फ़ाइल डाउनलोड हुई / CSV downloaded.";
      } else {
        downloadFile(JSON.stringify(snapshot, null, 2), "application/json", `bolkhata-backup-${dateStamp()}.json`);
        statusBox.textContent = "बैकअप डाउनलोड हुआ—सुरक्षित रखें / Backup downloaded—store it safely.";
      }
    })
    .catch((error) => {
      statusBox.textContent = `डाउनलोड नहीं हुआ: ${error.message} / Export failed: ${error.message}`;
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
    if (!window.confirm("यह बैकअप रीस्टोर करें? इससे इस डिवाइस का मौजूदा डेटा बदल जाएगा। / Restore backup? This replaces current data on this device.")) {
      statusBox.textContent = "रीस्टोर रद्द—मौजूदा डेटा वही है / Restore canceled; current data is unchanged.";
      return;
    }

    await replaceDatabaseWithBackup(backup);
    statusBox.textContent = "बैकअप रीस्टोर हुआ / Backup restored.";
    renderAll();
  } catch (error) {
    statusBox.textContent = `रीस्टोर नहीं हुआ: ${error.message} / Restore failed: ${error.message}`;
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

function clearCredit(name, statusMessage = "ग्राहक का उधार हटाया / Customer credit cleared.") {
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
        note: "बाकी उधार रद्द / Outstanding credit canceled."
      });
      creditStore.delete(name);
    }
  };

  tx.oncomplete = () => {
    editingCreditName = null;
    statusBox.textContent = creditFound ? statusMessage : "ग्राहक का उधार नहीं मिला / Customer credit not found.";
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
      ? `${name} का उधार बही खाते में जोड़ा / Credit for ${name} moved to Bahi Khata.`
      : "ग्राहक का उधार नहीं मिला / Customer credit not found.";
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
      ? `${oldName} का नाम ${newName} किया; बाकी रकम जोड़ी / Renamed ${oldName} to ${newName}; balances combined.`
      : `${oldName} का नाम ${newName} किया / Renamed ${oldName} to ${newName} in records and history.`;
    renderAll();
  };
  tx.onabort = () => {
    statusBox.textContent = `${oldName} का नाम नहीं बदला: ${tx.error ? tx.error.message : "बदलाव रद्द"} / Could not rename: ${tx.error ? tx.error.message : "Update canceled"}.`;
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
      ? "सप्लाई डिलीवर हुई और सूची में जोड़ी / Supply delivered and added to delivered list."
      : "सप्लाई ऑर्डर नहीं मिला / Supply order not found.";
    renderAll();
  };
}
