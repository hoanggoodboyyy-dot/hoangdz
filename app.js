(() => {
  "use strict";

  const DIFFICULTY = 2;
  const GENESIS_PREVIOUS_HASH = "0".repeat(64);
  const MAX_NONCE = 100_000_000;
  const MAX_NOTE_LENGTH = 200;
  const MAX_PARTY_LENGTH = 100;
  const MAX_BACKUP_SIZE = 10 * 1024 * 1024;
  const MAX_BLOCKS = 10000;
  const MAX_TRANSACTIONS = 20000;
  const BACKUP_FORMAT = "blocklab-blockchain-backup";
  const BACKUP_VERSION = 1;
  const DATABASE_NAME = "blocklab-blockchain";
  const DATABASE_STORE = "snapshots";
  const DATABASE_RECORD_ID = "current";
  const byId = (id) => document.getElementById(id);
  let database = null;
  let databaseWritable = false;

  const elements = {
    form: byId("transaction-form"),
    sender: byId("sender"),
    receiver: byId("receiver"),
    amount: byId("amount"),
    note: byId("note"),
    addButton: byId("add-transaction"),
    mineButton: byId("mine-block"),
    verifyButton: byId("verify-chain"),
    resetButton: byId("reset-chain"),
    exportButton: byId("export-backup"),
    importButton: byId("import-backup"),
    backupFile: byId("backup-file"),
    storageStatus: byId("storage-status"),
    tamperButton: byId("tamper-block"),
    tamperEditor: byId("tamper-editor"),
    tamperTransaction: byId("tamper-transaction"),
    tamperNote: byId("tamper-note"),
    cancelTamper: byId("cancel-tamper"),
    cancelTamperAction: byId("cancel-tamper-action"),
    blockCount: byId("block-count"),
    pendingCount: byId("pending-count"),
    pendingCounter: byId("pending-counter"),
    pendingList: byId("pending-list"),
    listCount: byId("list-count"),
    blockList: byId("block-list"),
    details: byId("block-details"),
    detailLabel: byId("detail-label"),
    chainState: byId("chain-state"),
    chainStateText: byId("chain-state-text"),
    notice: byId("notice"),
    noticeText: byId("notice-text"),
  };

  const state = {
    chain: [],
    pendingTransactions: [],
    selectedBlockIndex: 0,
    busy: false,
  };

  function setStorageStatus(message, isError = false) {
    elements.storageStatus.textContent = message;
    elements.storageStatus.classList.toggle("error", isError);
  }

  function openDatabase() {
    if (!window.indexedDB) {
      return Promise.reject(new Error("Trình duyệt này không hỗ trợ IndexedDB."));
    }
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const storeDatabase = request.result;
        if (!storeDatabase.objectStoreNames.contains(DATABASE_STORE)) {
          storeDatabase.createObjectStore(DATABASE_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => {
          database.close();
          database = null;
          databaseWritable = false;
          setStorageStatus("Cơ sở dữ liệu đã đóng; hãy tải lại trang.", true);
        };
        resolve(database);
      };
      request.onerror = () => {
        reject(new Error(`Không thể mở cơ sở dữ liệu: ${request.error?.message || "lỗi IndexedDB"}`));
      };
      request.onblocked = () => {
        reject(new Error("Cơ sở dữ liệu đang bị chặn bởi một tab khác."));
      };
    });
  }

  function readStoredState() {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(DATABASE_STORE, "readonly");
      const request = transaction.objectStore(DATABASE_STORE).get(DATABASE_RECORD_ID);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error("Không đọc được dữ liệu trong IndexedDB."));
      transaction.onerror = () => reject(new Error("Lỗi khi đọc dữ liệu trong IndexedDB."));
      transaction.onabort = () => reject(new Error("Đọc dữ liệu trong IndexedDB đã bị hủy."));
    });
  }

  function writeStoredState() {
    if (!database || !databaseWritable) {
      return Promise.reject(new Error("Chưa thể ghi vào IndexedDB. Hãy nhập bản sao lưu hoặc khởi tạo lại chuỗi."));
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(DATABASE_STORE, "readwrite");
      transaction.objectStore(DATABASE_STORE).put({
        id: DATABASE_RECORD_ID,
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        savedAt: new Date().toISOString(),
        chain: state.chain.map((block) => ({
          index: block.index,
          timestamp: block.timestamp,
          transactions: block.transactions.map(encodeTransaction),
          previousHash: block.previousHash,
          nonce: block.nonce,
          hash: block.hash,
        })),
        pendingTransactions: state.pendingTransactions.map(encodeTransaction),
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Không thể lưu dữ liệu vào IndexedDB."));
      transaction.onabort = () => reject(new Error("Lưu dữ liệu vào IndexedDB đã bị hủy."));
    });
  }

  async function persistState(successMessage, noticeType = "success") {
    try {
      await writeStoredState();
      setStorageStatus("Đã tự lưu vào cơ sở dữ liệu trình duyệt.");
      setNotice(successMessage, noticeType);
    } catch (error) {
      setStorageStatus("Không lưu được vào cơ sở dữ liệu.", true);
      setNotice(`${successMessage} Dữ liệu chỉ còn trong tab này: ${error.message}`, "error");
    }
  }

  function normalizeTransaction(transaction) {
    if (!transaction || typeof transaction !== "object") {
      throw new Error("File chứa giao dịch không hợp lệ.");
    }
    const sender = typeof transaction.sender === "string" ? transaction.sender.trim() : "";
    const receiver = typeof transaction.receiver === "string" ? transaction.receiver.trim() : "";
    const amount = String(transaction.amount ?? "").trim();
    const amountNumber = Number(amount);
    const note = typeof transaction.note === "string" ? transaction.note : "";
    const timestamp = transaction.timestamp;
    if (!sender || sender.length > MAX_PARTY_LENGTH || !receiver
        || receiver.length > MAX_PARTY_LENGTH) {
      throw new Error("Tên người gửi/nhận trong file không hợp lệ.");
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0 || amount.length > 50) {
      throw new Error("Số lượng trong file không hợp lệ.");
    }
    if (note.length > MAX_NOTE_LENGTH) {
      throw new Error("Ghi chú trong file vượt quá 200 ký tự.");
    }
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error("Thời gian giao dịch trong file không hợp lệ.");
    }
    return { sender, receiver, amount, note, timestamp };
  }

  function normalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object"
        || snapshot.format !== BACKUP_FORMAT || snapshot.version !== BACKUP_VERSION) {
      throw new Error("File không đúng định dạng sao lưu Blockchain hoặc phiên bản không được hỗ trợ.");
    }
    if (!Array.isArray(snapshot.chain) || snapshot.chain.length === 0
        || snapshot.chain.length > MAX_BLOCKS || !Array.isArray(snapshot.pendingTransactions)) {
      throw new Error("Danh sách Block hoặc giao dịch trong file không hợp lệ.");
    }
    const chain = snapshot.chain.map((block) => {
      if (!block || typeof block !== "object"
          || !Number.isSafeInteger(block.index) || block.index < 0
          || typeof block.timestamp !== "string" || !Number.isFinite(Date.parse(block.timestamp))
          || !Array.isArray(block.transactions)
          || typeof block.previousHash !== "string" || !/^[0-9a-f]{64}$/i.test(block.previousHash)
          || !Number.isSafeInteger(block.nonce) || block.nonce < 0 || block.nonce > MAX_NONCE
          || typeof block.hash !== "string" || !/^[0-9a-f]{64}$/i.test(block.hash)) {
        throw new Error("Cấu trúc Block trong file không hợp lệ.");
      }
      return {
        index: block.index,
        timestamp: block.timestamp,
        transactions: block.transactions.map(normalizeTransaction),
        previousHash: block.previousHash,
        nonce: block.nonce,
        hash: block.hash,
      };
    });
    const pendingTransactions = snapshot.pendingTransactions.map(normalizeTransaction);
    const transactionCount = chain.reduce((total, block) => total + block.transactions.length, 0)
      + pendingTransactions.length;
    if (transactionCount > MAX_TRANSACTIONS) {
      throw new Error("File có quá nhiều giao dịch để mở an toàn.");
    }
    return { chain, pendingTransactions };
  }

  function encodeTransaction(transaction) {
    return {
      sender: transaction.sender,
      receiver: transaction.receiver,
      amount: transaction.amount,
      note: transaction.note,
      timestamp: transaction.timestamp,
    };
  }

  function canonicalBlockData(block) {
    return JSON.stringify({
      index: block.index,
      timestamp: block.timestamp,
      transactions: block.transactions.map(encodeTransaction),
      previousHash: block.previousHash,
      nonce: block.nonce,
    });
  }

  async function calculateHash(block) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Trình duyệt chưa hỗ trợ Web Crypto. Hãy mở trang qua HTTPS hoặc localhost.");
    }
    const bytes = new TextEncoder().encode(canonicalBlockData(block));
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function mineBlock(block, onProgress) {
    const prefix = "0".repeat(DIFFICULTY);
    block.nonce = 0;
    while (block.nonce < MAX_NONCE) {
      block.hash = await calculateHash(block);
      if (block.hash.startsWith(prefix)) {
        return block;
      }
      block.nonce += 1;
      if (block.nonce % 500 === 0) {
        onProgress(block.nonce);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    throw new Error("Không tìm được nonce trong giới hạn cho phép.");
  }

  async function createGenesisBlock() {
    const genesis = {
      index: 0,
      timestamp: new Date().toISOString(),
      transactions: [],
      previousHash: GENESIS_PREVIOUS_HASH,
      nonce: 0,
      hash: "",
    };
    return mineBlock(genesis, () => {});
  }

  async function validateChain(chain = state.chain) {
    if (chain.length === 0) {
      return { valid: false, blockIndex: -1, message: "Blockchain không có Genesis Block." };
    }
    for (let index = 0; index < chain.length; index += 1) {
      const current = chain[index];
      if (current.index !== index) {
        return { valid: false, blockIndex: index, message: `Sai thứ tự index tại Block #${index}.` };
      }
      const expectedPreviousHash = index === 0
        ? GENESIS_PREVIOUS_HASH
        : chain[index - 1].hash;
      if (current.previousHash !== expectedPreviousHash) {
        return { valid: false, blockIndex: index, message: `Liên kết previousHash sai tại Block #${index}.` };
      }
      if (await calculateHash(current) !== current.hash) {
        return {
          valid: false,
          blockIndex: index,
          message: `Hash không khớp tại Block #${index}; dữ liệu có thể đã bị sửa.`,
        };
      }
      if (!current.hash.startsWith("0".repeat(DIFFICULTY))) {
        return { valid: false, blockIndex: index, message: `Block #${index} không đạt Proof of Work.` };
      }
    }
    return { valid: true, blockIndex: -1, message: "Blockchain hợp lệ." };
  }

  function setNotice(message, type = "info") {
    elements.noticeText.textContent = message;
    elements.notice.className = `notice${type === "error" ? " error" : type === "success" ? " success" : ""}`;
  }

  function setBusy(busy) {
    state.busy = busy;
    elements.addButton.disabled = busy;
    elements.mineButton.disabled = busy;
    elements.verifyButton.disabled = busy;
    elements.resetButton.disabled = busy;
    elements.exportButton.disabled = busy;
    elements.importButton.disabled = busy;
    elements.tamperButton.disabled = busy || !canTamperSelectedBlock();
  }

  function canTamperSelectedBlock() {
    const selected = state.chain[state.selectedBlockIndex];
    return Boolean(selected && selected.index > 0 && selected.transactions.length > 0);
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(value));
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function renderStats() {
    elements.blockCount.textContent = String(state.chain.length);
    elements.pendingCount.textContent = String(state.pendingTransactions.length);
    elements.pendingCounter.textContent = String(state.pendingTransactions.length);
    elements.listCount.textContent = `${state.chain.length} khối`;
  }

  function renderPendingTransactions() {
    elements.pendingList.replaceChildren();
    if (state.pendingTransactions.length === 0) {
      elements.pendingList.append(makeElement("p", "empty-hint", "Chưa có giao dịch nào đang chờ."));
      return;
    }
    state.pendingTransactions.forEach((transaction) => {
      const item = makeElement("div", "pending-item");
      const route = makeElement("span", "pending-route",
        `${transaction.sender} → ${transaction.receiver}`);
      const amount = makeElement("span", "pending-amount", transaction.amount);
      item.append(route, amount);
      elements.pendingList.append(item);
    });
  }

  function renderBlockList(validation) {
    elements.blockList.replaceChildren();
    state.chain.forEach((block, index) => {
      const valid = validation.valid || index < validation.blockIndex;
      const entry = makeElement("li", "block-list-entry");
      const button = makeElement("button", "block-item");
      button.type = "button";
      button.setAttribute("aria-pressed", String(index === state.selectedBlockIndex));
      button.setAttribute("aria-label", `Block #${index}, ${valid ? "hợp lệ" : "không hợp lệ"}`);
      button.addEventListener("click", () => {
        closeTamperEditor();
        state.selectedBlockIndex = index;
        render();
      });

      const title = makeElement("span", "block-item-title", `Block #${index}`);
      const status = makeElement("span", valid ? "valid-pill" : "invalid-pill",
        valid ? "HỢP LỆ" : "LỖI");
      const time = makeElement("span", "block-item-time", formatTime(block.timestamp));
      const hash = makeElement("span", "block-item-hash", `Hash: ${block.hash.slice(0, 18)}...`);
      button.append(title, status, time, hash);
      entry.append(button);
      elements.blockList.append(entry);
    });
  }

  function appendDetailRow(container, label, value) {
    container.append(
      makeElement("span", "detail-key", label),
      makeElement("span", "detail-value", value),
    );
  }

  function renderBlockDetails(validation) {
    const block = state.chain[state.selectedBlockIndex];
    elements.details.replaceChildren();
    if (!block) {
      elements.detailLabel.textContent = "CHỌN MỘT BLOCK";
      elements.details.append(makeElement("p", "empty-hint", "Chưa có Block để hiển thị."));
      return;
    }

    const valid = validation.valid || block.index < validation.blockIndex;
    elements.detailLabel.textContent = valid ? "HỢP LỆ" : "KHÔNG HỢP LỆ";
    const grid = makeElement("div", "detail-grid");
    appendDetailRow(grid, "Trạng thái", valid ? "Hợp lệ" : validation.message);
    appendDetailRow(grid, "Thời gian", formatTime(block.timestamp));
    appendDetailRow(grid, "Nonce", String(block.nonce));
    appendDetailRow(grid, "Proof of Work", `${DIFFICULTY} số 0 đầu hash`);
    appendDetailRow(grid, "Hash", block.hash);
    appendDetailRow(grid, "Previous hash", block.previousHash);
    elements.details.append(grid);

    const transactionHeading = makeElement("div", "transaction-heading");
    transactionHeading.append(
      makeElement("span", "", "GIAO DỊCH"),
      makeElement("span", "", String(block.transactions.length)),
    );
    elements.details.append(transactionHeading);

    if (block.transactions.length === 0) {
      elements.details.append(makeElement("p", "no-transactions", "Block này không có giao dịch."));
      return;
    }
    block.transactions.forEach((transaction, index) => {
      const card = makeElement("article", "detail-transaction");
      const heading = makeElement("div", "transaction-heading");
      heading.append(
        makeElement("span", "", `Giao dịch #${index + 1}`),
        makeElement("span", "", transaction.amount),
      );
      const fields = document.createElement("dl");
      const entries = [
        ["Người gửi", transaction.sender],
        ["Người nhận", transaction.receiver],
        ["Ghi chú", transaction.note || "(không có)"],
        ["Thời gian", formatTime(transaction.timestamp)],
      ];
      entries.forEach(([label, value]) => {
        fields.append(makeElement("dt", "", label), makeElement("dd", "", value));
      });
      card.append(heading, fields);
      elements.details.append(card);
    });
  }

  async function render() {
    renderStats();
    renderPendingTransactions();
    try {
      const validation = await validateChain();
      elements.chainState.classList.toggle("invalid", !validation.valid);
      elements.chainStateText.textContent = validation.valid ? "Chuỗi hợp lệ" : "Phát hiện sai lệch";
      elements.mineButton.disabled = state.busy || !validation.valid;
      elements.verifyButton.disabled = state.busy;
      elements.addButton.disabled = state.busy;
      elements.resetButton.disabled = state.busy;
      elements.exportButton.disabled = state.busy;
      elements.importButton.disabled = state.busy;
      elements.tamperButton.disabled = state.busy || !validation.valid || !canTamperSelectedBlock();
      renderBlockList(validation);
      renderBlockDetails(validation);
    } catch (error) {
      elements.chainState.classList.add("invalid");
      elements.chainStateText.textContent = "Không thể xác minh";
      elements.mineButton.disabled = true;
      elements.tamperButton.disabled = true;
      setNotice(error.message, "error");
    }
  }

  async function addTransaction(event) {
    event.preventDefault();
    const sender = elements.sender.value.trim();
    const receiver = elements.receiver.value.trim();
    const amountText = elements.amount.value.trim().replace(",", ".");
    const amountNumber = Number(amountText);
    const note = elements.note.value.trim();

    if (!sender || !receiver) {
      setNotice("Vui lòng nhập người gửi và người nhận.", "error");
      return;
    }
    if (sender.length > MAX_PARTY_LENGTH || receiver.length > MAX_PARTY_LENGTH) {
      setNotice("Tên người gửi và người nhận không được vượt quá 100 ký tự.", "error");
      return;
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setNotice("Số lượng phải là một số hợp lệ lớn hơn 0.", "error");
      return;
    }
    if (note.length > MAX_NOTE_LENGTH) {
      setNotice("Ghi chú không được vượt quá 200 ký tự.", "error");
      return;
    }

    state.pendingTransactions.push({
      sender,
      receiver,
      amount: amountNumber.toString(),
      note,
      timestamp: new Date().toISOString(),
    });
    elements.form.reset();
    await persistState("Đã thêm giao dịch vào danh sách chờ.");
    await render();
  }

  async function createBlock() {
    if (state.busy) {
      return;
    }
    setBusy(true);
    setNotice("Đang tìm nonce phù hợp...", "info");
    try {
      const validation = await validateChain();
      if (!validation.valid) {
        throw new Error("Chuỗi không hợp lệ. Hãy khởi tạo lại trước khi tạo Block.");
      }
      const previousBlock = state.chain[state.chain.length - 1];
      const block = {
        index: previousBlock.index + 1,
        timestamp: new Date().toISOString(),
        transactions: state.pendingTransactions.map(encodeTransaction),
        previousHash: previousBlock.hash,
        nonce: 0,
        hash: "",
      };
      await mineBlock(block, (nonce) => {
        setNotice(`Đang đào Block #${block.index} · nonce ${nonce.toLocaleString("vi-VN")}...`);
      });
      state.chain.push(block);
      state.pendingTransactions = [];
      state.selectedBlockIndex = block.index;
      await persistState(`Đã khai thác Block #${block.index} thành công.`);
    } catch (error) {
      setNotice(error.message, "error");
    } finally {
      state.busy = false;
      await render();
    }
  }

  async function verifyBlockchain() {
    if (state.busy) {
      return;
    }
    setBusy(true);
    try {
      const result = await validateChain();
      setNotice(result.message, result.valid ? "success" : "error");
    } catch (error) {
      setNotice(error.message, "error");
    } finally {
      state.busy = false;
      await render();
    }
  }

  async function tamperSelectedBlock() {
    if (state.busy || !canTamperSelectedBlock()) {
      return;
    }
    const block = state.chain[state.selectedBlockIndex];
    elements.tamperTransaction.replaceChildren();
    block.transactions.forEach((transaction, index) => {
      const option = makeElement("option", "", `Giao dịch #${index + 1} · ${transaction.sender} → ${transaction.receiver}`);
      option.value = String(index);
      elements.tamperTransaction.append(option);
    });
    const transaction = block.transactions[0];
    let suggestedNote = `${transaction.note} [sửa thử]`;
    if (suggestedNote.length > MAX_NOTE_LENGTH) {
      suggestedNote = suggestedNote.slice(0, MAX_NOTE_LENGTH);
    }
    if (suggestedNote === transaction.note) {
      suggestedNote = suggestedNote.slice(0, MAX_NOTE_LENGTH - 1);
    }
    elements.tamperNote.value = suggestedNote;
    elements.tamperEditor.hidden = false;
    elements.tamperNote.focus();
  }

  function closeTamperEditor() {
    elements.tamperEditor.hidden = true;
  }

  async function applyTampering(event) {
    event.preventDefault();
    if (state.busy || !canTamperSelectedBlock()) {
      closeTamperEditor();
      return;
    }
    const block = state.chain[state.selectedBlockIndex];
    const transactionIndex = Number(elements.tamperTransaction.value);
    const transaction = block.transactions[transactionIndex];
    if (!transaction) {
      setNotice("Không tìm thấy giao dịch cần sửa.", "error");
      return;
    }
    const normalizedNote = elements.tamperNote.value.trim();
    if (normalizedNote.length > MAX_NOTE_LENGTH) {
      setNotice("Ghi chú không được vượt quá 200 ký tự.", "error");
      return;
    }
    if (normalizedNote === transaction.note) {
      setNotice("Nội dung mới phải khác nội dung hiện tại.", "error");
      return;
    }
    transaction.note = normalizedNote;
    closeTamperEditor();
    await persistState(
      `Đã sửa dữ liệu thử nghiệm trong Block #${block.index}. Hãy kiểm tra chuỗi.`,
      "error",
    );
    await render();
  }

  function exportBackup() {
    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      chain: state.chain.map((block) => ({
        index: block.index,
        timestamp: block.timestamp,
        transactions: block.transactions.map(encodeTransaction),
        previousHash: block.previousHash,
        nonce: block.nonce,
        hash: block.hash,
      })),
      pendingTransactions: state.pendingTransactions.map(encodeTransaction),
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = downloadUrl;
    link.download = `blockchain-backup-${date}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setNotice("Đã tạo file sao lưu JSON để tải xuống.", "success");
  }

  async function importBackup(file) {
    if (!file) {
      return;
    }
    if (file.size > MAX_BACKUP_SIZE) {
      setNotice("File sao lưu vượt quá giới hạn 10 MB.", "error");
      elements.backupFile.value = "";
      return;
    }
    setBusy(true);
    try {
      const backup = JSON.parse(await file.text());
      const imported = normalizeSnapshot(backup);
      const validation = await validateChain(imported.chain);
      state.chain = imported.chain;
      state.pendingTransactions = imported.pendingTransactions;
      state.selectedBlockIndex = state.chain.length - 1;
      if (database) {
        databaseWritable = true;
      }
      const message = validation.valid
        ? "Đã nhập file và khôi phục dữ liệu Blockchain."
        : `Đã nhập file nhưng chuỗi có lỗi: ${validation.message}`;
      await persistState(message, validation.valid ? "success" : "error");
    } catch (error) {
      setNotice(`Không thể nhập file sao lưu: ${error.message}`, "error");
    } finally {
      elements.backupFile.value = "";
      state.busy = false;
      await render();
    }
  }

  async function resetBlockchain() {
    if (state.busy || !window.confirm("Khởi tạo lại Blockchain và xóa toàn bộ dữ liệu hiện tại?")) {
      return;
    }
    setBusy(true);
    try {
      const genesis = await createGenesisBlock();
      state.chain = [genesis];
      state.pendingTransactions = [];
      state.selectedBlockIndex = 0;
      if (database) {
        databaseWritable = true;
      }
      await persistState("Đã khởi tạo Blockchain mới.");
    } catch (error) {
      setNotice(error.message, "error");
    } finally {
      state.busy = false;
      await render();
    }
  }

  async function initialize() {
    elements.form.addEventListener("submit", addTransaction);
    elements.mineButton.addEventListener("click", createBlock);
    elements.verifyButton.addEventListener("click", verifyBlockchain);
    elements.resetButton.addEventListener("click", resetBlockchain);
    elements.exportButton.addEventListener("click", exportBackup);
    elements.importButton.addEventListener("click", () => elements.backupFile.click());
    elements.backupFile.addEventListener("change", (event) => {
      importBackup(event.target.files[0]);
    });
    elements.tamperButton.addEventListener("click", tamperSelectedBlock);
    elements.tamperEditor.addEventListener("submit", applyTampering);
    elements.cancelTamper.addEventListener("click", closeTamperEditor);
    elements.cancelTamperAction.addEventListener("click", closeTamperEditor);
    setBusy(true);
    try {
      setStorageStatus("Đang mở cơ sở dữ liệu...");
      await openDatabase();
      const savedState = await readStoredState();
      if (savedState) {
        const restored = normalizeSnapshot(savedState);
        state.chain = restored.chain;
        state.pendingTransactions = restored.pendingTransactions;
        state.selectedBlockIndex = state.chain.length - 1;
        databaseWritable = true;
        const validation = await validateChain();
        setStorageStatus("Đã khôi phục từ IndexedDB; tự lưu đang bật.");
        setNotice(validation.valid
          ? "Đã khôi phục dữ liệu Blockchain từ cơ sở dữ liệu trình duyệt."
          : `Dữ liệu đã khôi phục nhưng chuỗi có lỗi: ${validation.message}`,
        validation.valid ? "success" : "error");
      } else {
        state.chain = [await createGenesisBlock()];
        state.selectedBlockIndex = 0;
        databaseWritable = true;
        await writeStoredState();
        setStorageStatus("Đã tạo IndexedDB; mọi thay đổi sẽ tự lưu.");
        setNotice("Blockchain đã sẵn sàng. Hãy thêm giao dịch đầu tiên.", "success");
      }
    } catch (error) {
      databaseWritable = false;
      setStorageStatus("Không kết nối được IndexedDB.", true);
      if (state.chain.length === 0) {
        try {
          state.chain = [await createGenesisBlock()];
        } catch (genesisError) {
          setNotice(`Không thể khởi tạo Blockchain: ${genesisError.message}`, "error");
        }
      }
      setNotice(
        `Cơ sở dữ liệu không dùng được: ${error.message}. Bạn vẫn có thể tải file JSON để sao lưu.`,
        "error",
      );
    } finally {
      state.busy = false;
      await render();
    }
  }

  initialize();
})();
