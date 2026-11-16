# BolKhata
# ☕ BolKhata — Zero-Typing Voice & Offline Khata for Small Shopkeepers

**VibeX Codes Hackathon Submission — Track 1: Helping Daily Workers, Small Shopkeepers (Chaiwalas) & Office Workers**

🌐 **Live Demo:** [https://netlify.app](https://netlify.app)  


---

## 🎯 The Problem
Millions of street vendors, tea stall owners (*chaiwalas*), and small *kirana* shopkeepers work 14-hour shifts with wet, busy hands in noisy street environments. During rush hours, they cannot stop serving customers to unlock a smartphone and type in English—leading to forgotten customer credit (*udhaar*), missed supplier orders (milk, sugar, tea leaves), and daily revenue loss. Furthermore, unreliable street mobile data causes cloud-only apps to lag or fail.

## 💡 The Solution
**BolKhata** is a bilingual (Hindi/Hinglish + English), local-first Progressive Web Workspace that lets shopkeepers manage customer credit, payments, and tomorrow's supply orders hands-free—with zero typing and zero paid AI API dependencies.

### ✨ Key Features
* **🎙️ Hands-Free Voice Entry (Hindi / Hinglish):** Speak naturally to log credit, record payments, check balances, or add supply orders.
* **🛡️ Street-Noise Safety ("Review & Confirm"):** Displays recognized speech before saving (`Confirm and save` / `Cancel`) and enforces strict validation (requires customer names and blocks overpayments beyond due balances).
* **📒 Complete Accounting Loop:**
  * **Today's Summary:** Real-time totals for outstanding credit, pending supply orders, and daily deliveries.
  * **Customer Credit & Ledger:** Track individual balances, view dated transaction history, and send **one-tap WhatsApp payment reminders**.
  * **Bahi Khata & Supplies:** Automatically archives paid credits and delivered supply orders.
* **⚡ Local-First Offline Core (IndexedDB):** All customer balances, ledgers, quick-text entries, and backups work **100% offline** with zero lag.
* **☁️ Optional Cloud Sync & Backups:** Sign in via **Supabase** to sync across devices, or export/restore local data anytime via **CSV** and **JSON backups**.

---

## 🗣️ Supported Voice & Quick-Entry Commands

| Action | Example Command (Hindi / Hinglish) | What BolKhata Does |
| :--- | :--- | :--- |
| **Add Credit (*Udhaar*)** | `"Amit 50 rupay udhar"` | Adds ₹50 credit to Amit's account (creates customer if new). |
| **Record Payment** | `"Ramesh ne 40 rupay de diye"` | Deducts ₹40 from Ramesh's balance and logs it in *Bahi Khata*. |
| **Check Balance** | `"Ramesh ka balance kitna hai?"` | Displays Ramesh's current outstanding balance immediately. |
| **Add Supply Order** | `"2 kg sugar"` or `"1 litre milk order"` | Adds item to *Tomorrow's supply* list. |

---

## 🛠️ Tech Stack & Architecture
* **Frontend:** Semantic HTML5, Responsive CSS3, Vanilla JavaScript (ES6+)
* **Local-First Database:** Browser **IndexedDB** (instant offline reads/writes)
* **Voice Recognition:** Browser **Web Speech API** (`SpeechRecognition`) + custom Hindi/Hinglish intent parser *(Note: Voice transcription relies on browser speech services when online; manual quick-entry and all stored ledgers work 100% offline)*
* **Authentication & Cloud Sync:** **Supabase** (Email/Password Auth + PostgreSQL sync)
* **Hosting:** **Netlify** (HTTPS enabled for microphone access)

---

## 🚀 Run Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com
   cd bolkhata
   ```
2. **Start a local server** (required for browser microphone permissions and IndexedDB):
   ```bash
   npx serve .
   ```
   *(Or open `index.html` using VS Code **Live Server**)*
3. Open `http://localhost:3000` in **Google Chrome** and allow microphone permissions.

---

## 🔒 Privacy & Cost Efficiency
BolKhata processes voice commands directly through native browser APIs without routing vendor audio through expensive third-party speech APIs—keeping running costs at **₹0** so the tool remains free and accessible for micro-merchants.
