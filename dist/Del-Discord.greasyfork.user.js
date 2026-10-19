// ==UserScript==
// @name         Del-Discord
// @namespace    local.del-discord
// @version      2.5.0
// @author       Del-Discord contributors
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjOTY5NjkwIiBkPSJNMTUgNFYySDl2MkgzdjJoMThWNGgtNlpNNSA3djEyYTIgMiAwIDAgMCAyIDJoMTBhMiAyIDAgMCAwIDItMlY3SDVabTYgMTBIOXYtNmgydjZabTQgMGgtMnYtNmgydjZaIi8+PC9zdmc+
// @homepageURL  https://github.com/azhomy/del-discord
// @supportURL   https://github.com/azhomy/del-discord/issues
// @license      MIT
// @description  Personal message deletion, reaction removal, queues, exports, and DM history.
// @match        https://discord.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Local build. No remote updates or hosted dependencies.

/*
MIT License

Copyright (c) 2026 Del-Discord contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(() => {
  // src/utils/expiring-storage.js
  var CACHE_LIFETIME = 3 * 24 * 60 * 60 * 1e3;
  function createExpiringStorage(key, storage, now = () => Date.now()) {
    const getStorage = () => {
      try {
        return storage || globalThis.localStorage;
      } catch {
        return null;
      }
    };
    const stampKey = `${key}_created_at`;
    const read = () => {
      const storage2 = getStorage();
      if (!storage2) return null;
      const value = storage2.getItem(key);
      if (value === null) return null;
      const stamp = Number(storage2.getItem(stampKey));
      if (!stamp) {
        storage2.setItem(stampKey, String(now()));
        return value;
      }
      if (now() - stamp >= CACHE_LIFETIME || stamp > now()) {
        clear();
        return null;
      }
      return value;
    };
    const clear = () => {
      const storage2 = getStorage();
      if (!storage2) return;
      storage2.removeItem(key);
      storage2.removeItem(stampKey);
    };
    const write = (value) => {
      const storage2 = getStorage();
      if (!storage2) return false;
      const stamp = Number(storage2.getItem(stampKey));
      if (!stamp || now() - stamp >= CACHE_LIFETIME || stamp > now()) storage2.setItem(stampKey, String(now()));
      storage2.setItem(key, value);
      return true;
    };
    return { read, write, clear };
  }

  // src/ui/saved-settings.js
  var KEY = "del_discord_v1_message_settings";
  function installSavedSettings(panel, { getMode, setMode, onReset = () => {
  }, onStorageError = () => {
  } }) {
    const cache = createExpiringStorage(KEY);
    const fields = [...panel.querySelectorAll("#dmd-messages input:not([type=password]):not([type=file]), #dmd-messages textarea, #dmd-messages select:not([multiple])")];
    const defaults = new Map(fields.map((field) => [field.id, field.type === "checkbox" ? field.checked : field.value]));
    let restoring = true;
    try {
      const saved = JSON.parse(cache.read() || "null");
      if (saved && typeof saved === "object") {
        for (const field of fields) {
          const value = saved.fields?.[field.id];
          if (field.type === "checkbox" && typeof value === "boolean") field.checked = value;
          else if (typeof value === "string" && (field.tagName !== "SELECT" || [...field.options].some((option) => option.value === value))) field.value = value;
        }
        if (["dm", "channel", "server", "forums", "thread"].includes(saved.mode)) setMode(saved.mode);
      }
    } catch {
    }
    restoring = false;
    let storageWarning = false;
    const save = () => {
      if (restoring) return;
      const values = Object.fromEntries(fields.map((field) => [field.id, field.type === "checkbox" ? field.checked : field.value]));
      try {
        if (!cache.write(JSON.stringify({ mode: getMode(), fields: values }))) throw new Error("Storage unavailable");
      } catch {
        if (!storageWarning) {
          storageWarning = true;
          onStorageError();
        }
      }
    };
    let timer;
    fields.forEach((field) => {
      field.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(save, 150);
      });
      field.addEventListener("change", () => {
        clearTimeout(timer);
        save();
      });
      field.addEventListener("blur", () => {
        clearTimeout(timer);
        save();
      });
    });
    const clear = () => {
      clearTimeout(timer);
      restoring = true;
      for (const field of fields) {
        if (field.type === "checkbox") field.checked = defaults.get(field.id);
        else field.value = defaults.get(field.id);
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
      setMode("dm");
      restoring = false;
      try {
        cache.clear();
      } catch {
      }
      onReset();
    };
    return { save, clear };
  }

  // src/ui/trash-icon.js
  function trashIcon(fill = "currentColor", size = 22) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${fill}" d="M15 4V2H9v2H3v2h18V4h-6ZM5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7H5Zm6 10H9v-6h2v6Zm4 0h-2v-6h2v6Z"/></svg>`;
  }

  // src/utils/async-cache.js
  function createAsyncCache({ ttl = 6e4, limit = 16 } = {}) {
    const entries = /* @__PURE__ */ new Map();
    const peek = (key) => {
      const entry = entries.get(key);
      if (entry && !entry.pending && Date.now() - entry.time >= ttl) {
        entries.delete(key);
        return;
      }
      return entry;
    };
    const get = (key, loader) => {
      const existing = peek(key);
      if (existing) {
        entries.delete(key);
        entries.set(key, existing);
        return existing.promise;
      }
      const entry = { pending: true, time: Date.now() };
      entry.promise = Promise.resolve().then(loader).then((value) => {
        entry.pending = false;
        entry.time = Date.now();
        return value;
      }, (error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return entry.promise;
    };
    return { get, peek };
  }

  // src/config.js
  var API = "https://discord.com/api/v10";
  var MAX_REACTION_SCAN = 5e3;
  var MAX_MESSAGE_IDS = 1e4;
  var MAX_MESSAGE_ID_TEXT = 12e5;
  var QUEUE_KEY = "del_discord_v1_queue";
  var LOG_ENTRY_LIMIT = 1e4;
  var LOG_DOM_LIMIT = 600;
  var LOG_DOM_TRIM = 120;
  var AUTH_CACHE_TTL = 6e4;

  // src/utils/timing.js
  var sleep = (ms) => {
    const chunk = Math.min(ms, 2147483647);
    return new Promise((resolve) => setTimeout(resolve, chunk)).then(() => ms > chunk ? sleep(ms - chunk) : void 0);
  };
  var rand = (a, b) => {
    const range = b - a + 1;
    if (globalThis.crypto?.getRandomValues && Number.isSafeInteger(range) && range > 0 && range <= 4294967296) {
      const values = new Uint32Array(1);
      const ceiling = Math.floor(4294967296 / range) * range;
      do {
        crypto.getRandomValues(values);
      } while (values[0] >= ceiling);
      return a + values[0] % range;
    }
    return Math.floor(Math.random() * range) + a;
  };
  var retryMs = (value) => {
    const seconds = Number(value);
    return value !== null && value !== "" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1e3 : 1500;
  };

  // src/utils/abort.js
  function waitWithSignal(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(signal.reason || new DOMException("Stopped.", "AbortError"));
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      promise.then((value) => {
        cleanup();
        resolve(value);
      }, (error) => {
        cleanup();
        reject(error);
      });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  // src/discord/api.js
  var RunStoppedError = class extends Error {
    constructor() {
      super("Stopped.");
      this.name = "RunStoppedError";
    }
  };
  var RateLimitError = class extends Error {
    constructor() {
      super("Repeated rate limits. Requests stopped; wait before trying again.");
      this.name = "RateLimitError";
    }
  };
  var paceTail = Promise.resolve();
  var lastPacedStart = null;
  async function paceRequest(interval, stopCheck, signal) {
    const previous = paceTail;
    let release;
    const turn = new Promise((resolve) => {
      release = resolve;
    });
    paceTail = previous.then(() => turn);
    try {
      await waitWithSignal(previous, signal);
      if (stopCheck()) throw new RunStoppedError();
      if (lastPacedStart !== null) {
        const wait = interval - (performance.now() - lastPacedStart);
        if (wait > 0) await waitWithSignal(sleep(wait), signal);
      }
      if (stopCheck()) throw new RunStoppedError();
      lastPacedStart = performance.now();
    } finally {
      release();
    }
  }
  var cooldowns = /* @__PURE__ */ new Map();
  function pauseAccount(key, milliseconds) {
    const previous = cooldowns.get(key);
    const pause = Promise.all([previous, sleep(milliseconds + rand(250, 750))]).finally(() => {
      if (cooldowns.get(key) === pause) cooldowns.delete(key);
    });
    cooldowns.set(key, pause);
    return pause;
  }
  async function apiFetch(url, options = {}, log = () => {
  }, stopCheck = () => false, { minIntervalMs = 0, maxRateLimitRetries = 2 } = {}) {
    let retries = 0;
    const account = new Headers(options.headers).get("Authorization") || new URL(url).origin;
    while (true) {
      if (stopCheck()) throw new RunStoppedError();
      let cooldown;
      while (cooldown = cooldowns.get(account)) {
        await waitWithSignal(cooldown, options.signal);
        if (stopCheck()) throw new RunStoppedError();
      }
      if (minIntervalMs > 0) {
        await paceRequest(minIntervalMs, stopCheck, options.signal);
        if (cooldowns.has(account)) continue;
      }
      if (stopCheck()) throw new RunStoppedError();
      options.signal?.throwIfAborted();
      const response = await waitWithSignal(fetch(url, options), options.signal);
      if (response.status !== 429) {
        const reset = response.headers.get("X-RateLimit-Reset-After");
        if (response.headers.get("X-RateLimit-Remaining") === "0" && reset !== null && Number.isFinite(Number(reset)) && Number(reset) >= 0) {
          pauseAccount(account, retryMs(reset));
        }
        return response;
      }
      let body = {};
      try {
        body = await waitWithSignal(response.json(), options.signal) || {};
      } catch {
      }
      const seconds = (value) => value !== null && value !== "" && ["number", "string"].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) * 1e3 : null;
      const header = response.headers.get("Retry-After");
      let headerDelay = seconds(header);
      if (headerDelay === null && header && /GMT$/i.test(header)) {
        const date = Date.parse(header);
        if (Number.isFinite(date)) headerDelay = Math.max(0, date - Date.now());
      }
      const hints = [seconds(body.retry_after), headerDelay, seconds(response.headers.get("X-RateLimit-Reset-After"))].filter((value) => value !== null);
      const delay = hints.length ? Math.max(...hints) : Math.min(3e4, 1500 * 2 ** retries);
      const pause = pauseAccount(account, delay);
      options.signal?.throwIfAborted();
      if (retries++ >= maxRateLimitRetries) throw new RateLimitError();
      log("warn", `Rate limited. Waiting at least ${(delay / 1e3).toFixed(1)}s before retry ${retries}/${maxRateLimitRetries}...`);
      await waitWithSignal(pause, options.signal);
    }
  }

  // src/ui/channel-picker.js
  function installChannelPickers($, allowMessages = () => true) {
    const cache = createAsyncCache();
    const tokenInput = $("#dmd-token");
    const controllers = [["#dmd-guild", "#dmd-channel", allowMessages], ["#dmd-multi-guild", "#dmd-multi-channel", () => true], ["#dmd-rx-guild", "#dmd-rx-channel", () => true]].filter(([guildId, channelId]) => $(guildId) && $(channelId)).map(([guildId, channelId, allowed]) => {
      const guild = $(guildId), input = $(channelId);
      const wrapper = document.createElement("div");
      wrapper.className = "dmd-channel-picker";
      wrapper.hidden = true;
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "dmd-select-trigger";
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", "Choose channels");
      const menu = document.createElement("div");
      menu.className = "dmd-channel-menu";
      menu.id = `${input.id}-channel-menu`;
      menu.hidden = true;
      menu.setAttribute("role", "group");
      menu.setAttribute("aria-label", "Channels");
      trigger.setAttribute("aria-controls", menu.id);
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "Find a channel";
      search.maxLength = 100;
      search.setAttribute("aria-label", "Find a channel");
      const choices = document.createElement("div");
      choices.className = "dmd-channel-choices";
      const manual = document.createElement("button");
      manual.type = "button";
      manual.className = "dmd-btn";
      manual.textContent = "Enter IDs instead";
      menu.append(search, choices, manual);
      wrapper.append(trigger);
      input.after(wrapper);
      document.body.appendChild(menu);
      let channels = [], channelNames = /* @__PURE__ */ new Map(), rows = [], choicesReady = false, version = 0, timer, manualGuild = "", lastKey = "", loadedKey = "";
      const panel = input.closest("#dmd-panel");
      const close = () => {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("resize", close);
        panel?.removeEventListener("scroll", close, true);
      };
      const outside = (event) => {
        if (!wrapper.contains(event.target) && !menu.contains(event.target)) close();
      };
      const selected = () => input.value.split(",").map((id) => id.trim()).filter(Boolean);
      const empty = document.createElement("div");
      empty.className = "dmd-muted";
      choices.onchange = (event) => {
        const checkbox = event.target;
        if (checkbox.type !== "checkbox") return;
        const values = new Set(selected());
        checkbox.checked ? values.add(checkbox.value) : values.delete(checkbox.value);
        input.value = [...values].join(", ");
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const sync = () => {
        const ids = selected();
        trigger.textContent = ids.length === 1 ? channelNames.has(ids[0]) ? `#${channelNames.get(ids[0])}` : ids[0] : ids.length ? `${ids.length} channels selected` : "Select channels";
        if (menu.hidden) return;
        const selectedIds = new Set(ids), term = search.value.trim().toLowerCase();
        let visible = 0;
        for (const row of rows) {
          row.checkbox.checked = selectedIds.has(row.id);
          row.label.hidden = !row.searchName.includes(term);
          if (!row.label.hidden) visible++;
        }
        empty.hidden = visible > 0;
        empty.textContent = channels.length ? "No matching channels." : "No message channels available.";
      };
      const buildChoices = () => {
        const fragment = document.createDocumentFragment();
        rows = [];
        for (const channel of channels) {
          const label = document.createElement("label");
          label.className = "dmd-channel-option";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = channel.id;
          const name = document.createElement("span");
          name.textContent = `${[15, 16].includes(channel.type) ? "Forum: " : "#"}${channel.name}`;
          rows.push({ id: channel.id, searchName: channel.name.toLowerCase(), label, checkbox });
          label.append(checkbox, name);
          fragment.appendChild(label);
        }
        fragment.appendChild(empty);
        choices.replaceChildren(fragment);
        choicesReady = true;
      };
      trigger.onclick = () => {
        if (!menu.hidden) {
          close();
          return;
        }
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        if (!choicesReady) buildChoices();
        sync();
        const rect = trigger.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
        menu.style.width = `${width}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
        const below = window.innerHeight - rect.bottom - 12;
        menu.style.top = below >= 180 ? `${rect.bottom + 5}px` : "auto";
        menu.style.bottom = below >= 180 ? "auto" : `${window.innerHeight - rect.top + 5}px`;
        menu.style.maxHeight = `${Math.max(120, Math.min(320, below >= 180 ? below : rect.top - 12))}px`;
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("resize", close);
        panel?.addEventListener("scroll", close, true);
        search.focus();
      };
      search.oninput = sync;
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          close();
          trigger.focus();
        }
      });
      manual.onclick = () => {
        manualGuild = guild.value.trim();
        wrapper.hidden = true;
        input.hidden = false;
        close();
        input.focus();
      };
      input.addEventListener("change", sync);
      input.addEventListener("input", sync);
      const refresh2 = async () => {
        const id = guild.value.trim(), token = tokenInput.value.trim();
        const valid = /^\d{15,22}$/.test(id) && allowed() && token;
        if (!valid || manualGuild === id) {
          ++version;
          wrapper.hidden = true;
          input.hidden = false;
          close();
          lastKey = "";
          return;
        }
        const key = `${token}/${id}`;
        const existing = cache.peek(key);
        if (loadedKey === key && lastKey === key && existing && !existing.pending) {
          sync();
          return;
        }
        lastKey = key;
        const requestVersion = ++version;
        wrapper.hidden = false;
        input.hidden = true;
        trigger.disabled = true;
        trigger.textContent = "Loading channels\u2026";
        close();
        try {
          const loaded = await cache.get(key, async () => {
            const response = await apiFetch(`${API}/guilds/${id}/channels`, { headers: { Authorization: token } });
            if (!response.ok) throw new Error(`Could not load channels (${response.status}).`);
            const data = await response.json();
            if (!Array.isArray(data)) throw new Error("Invalid channel list.");
            return data.filter((channel) => (!channel.guild_id || channel.guild_id === id) && [0, 5, 15, 16].includes(channel.type) && /^\d{15,22}$/.test(channel.id)).map((channel) => ({ id: channel.id, name: String(channel.name || channel.id), type: channel.type, position: Number(channel.position) || 0 })).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
          });
          if (requestVersion !== version || guild.value.trim() !== id || !allowed()) return;
          if (channels !== loaded) {
            channels = loaded;
            channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
            rows = [];
            choices.replaceChildren();
            choicesReady = false;
          }
          loadedKey = key;
          trigger.disabled = false;
          sync();
        } catch {
          if (requestVersion !== version) return;
          lastKey = "";
          wrapper.hidden = true;
          input.hidden = false;
          trigger.disabled = false;
          input.title = "Channel list unavailable. Enter channel IDs to continue.";
        }
      };
      input.addEventListener("blur", () => {
        if (!input.value.trim()) {
          manualGuild = "";
          lastKey = "";
          void refresh2();
        }
      });
      guild.addEventListener("input", () => {
        ++version;
        clearTimeout(timer);
        close();
        timer = setTimeout(() => void refresh2(), 400);
      });
      guild.addEventListener("change", () => {
        clearTimeout(timer);
        void refresh2();
      });
      return { refresh: refresh2 };
    });
    const refresh = () => Promise.all(controllers.map((controller) => controller.refresh()));
    tokenInput.addEventListener("change", () => void refresh());
    return { refresh };
  }

  // src/utils/storage.js
  var storageFrame = null;
  function siteStorage() {
    if (!storageFrame?.isConnected) {
      storageFrame = document.createElement("iframe");
      storageFrame.style.display = "none";
      storageFrame.setAttribute("aria-hidden", "true");
      document.body.appendChild(storageFrame);
    }
    return storageFrame.contentWindow.localStorage;
  }

  // src/discord/users.js
  function affinityEntries() {
    try {
      const raw = siteStorage().getItem("UserAffinitiesStoreV2");
      const arr = JSON.parse(raw || "{}")?._state?.userAffinities;
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  function getUserStore() {
    try {
      let found = null;
      window.webpackChunkdiscord_app?.push?.([[Math.random()], {}, (req) => {
        for (const key in req.c) {
          try {
            const exp = req.c[key]?.exports;
            const cands = [exp, exp?.default];
            if (exp && typeof exp === "object") cands.push(...Object.values(exp));
            for (const c of cands) {
              if (c && typeof c.getUser === "function" && typeof c.getUsers === "function") {
                found = c;
                return;
              }
            }
          } catch {
          }
        }
      }]);
      return found;
    } catch {
      return null;
    }
  }
  var users = getUserStore();
  var avatarUrl = (u) => u?.id && u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${String(u.avatar).startsWith("a_") ? "gif" : "png"}?size=64` : "";
  var userIconUrl = (user) => avatarUrl(user) || (/^\d+$/.test(user?.id || "") ? `https://cdn.discordapp.com/embed/avatars/${user.discriminator && user.discriminator !== "0" ? Number(user.discriminator) % 5 : Number((BigInt(user.id) >> 22n) % 6n)}.png` : "");
  var guildIconUrl = (guild) => guild?.id && guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${String(guild.icon).startsWith("a_") ? "gif" : "png"}?size=64` : "";
  var displayName = (u) => u?.global_name || u?.globalName || u?.username || "";
  var usernameOf = (u) => !u?.username ? "" : u.discriminator && u.discriminator !== "0" ? `${u.username}#${u.discriminator}` : `@${u.username}`;

  // src/discord/queue-identity.js
  var cleanQueueLabel = (label) => String(label || "").replace(/^Discord\s*[|—–-]\s*/i, "").replace(/\s*\|\s*Discord.*$/i, "").trim();
  function createQueueIdentityResolver() {
    const cache = createAsyncCache({ limit: 32 });
    const read = (kind, id, token, log) => cache.get(`${token}/${kind}/${id}`, async () => {
      const response = await apiFetch(`${API}/${kind}/${id}`, { headers: { Authorization: token } }, log);
      if (!response.ok) throw new Error(`Could not access ${kind === "guilds" ? "server" : "conversation"} (${response.status}).`);
      const data = await response.json();
      if (data.id !== id) throw new Error("Discord returned invalid identity metadata.");
      return data;
    });
    const resolve = async (item, token, log = () => {
    }) => {
      const result = { ...item, label: cleanQueueLabel(item.label) };
      if (!token || item.kind === "ids") return result;
      try {
        const server = item.guildId !== "@me";
        const data = await read(server ? "guilds" : "channels", server ? item.guildId : item.channelId, token, log);
        if (server) {
          result.icon = guildIconUrl(data);
          if (item.kind === "server") result.label = data.name || result.label;
          result.iconName = data.name || result.label;
        } else {
          let recipient = data.recipients?.[0];
          if (!recipient && data.recipient_ids?.[0]) recipient = users?.getUser?.(data.recipient_ids[0]);
          if (recipient?.id) {
            result.label = displayName(recipient) || result.label;
            result.icon = userIconUrl(recipient);
            result.iconName = result.label;
          }
        }
      } catch {
      }
      return result;
    };
    return { resolve, readGuild: (id, token, log = () => {
    }) => read("guilds", id, token, log) };
  }

  // src/discord/conversation.js
  async function resolveConversation({ token, channelId, log, stopCheck = () => false }) {
    if (!/^\d{15,22}$/.test(channelId)) throw new Error("Enter a valid conversation ID.");
    const response = await apiFetch(`${API}/channels/${channelId}`, { headers: { Authorization: token } }, log, stopCheck);
    if (stopCheck()) throw new RunStoppedError();
    if (!response.ok) throw new Error(`Could not detect conversation type (${response.status}). Check your access.`);
    const channel = await response.json();
    if (channel.id !== channelId) throw new Error("Discord returned an invalid conversation.");
    const mode = [1, 3].includes(channel.type) ? "dm" : [0, 5].includes(channel.type) ? "channel" : [15, 16].includes(channel.type) ? "forums" : [10, 11, 12].includes(channel.type) ? "thread" : null;
    if (!mode) throw new Error("This conversation type does not support message cleanup.");
    let guildId = mode === "dm" ? "@me" : channel.guild_id;
    if (!guildId && mode === "thread" && channel.parent_id) {
      const parent = await apiFetch(`${API}/channels/${channel.parent_id}`, { headers: { Authorization: token } }, log, stopCheck);
      if (stopCheck()) throw new RunStoppedError();
      if (!parent.ok) throw new Error(`Could not resolve thread server (${parent.status}).`);
      const data = await parent.json();
      if (data.id !== channel.parent_id) throw new Error("Discord returned an invalid thread parent.");
      guildId = data.guild_id;
    }
    if (mode !== "dm" && !/^\d{15,22}$/.test(guildId || "")) throw new Error("Discord did not provide a valid server ID.");
    return { mode, guildId, channelId, name: channel.name || channelId };
  }

  // src/discord/conversation-preview.js
  function createConversationPreviewResolver(resolve = resolveConversation, now = Date.now) {
    let cached = null, pending = null;
    const matches = (entry, options) => entry?.token === options.token && entry?.channelId === options.channelId;
    return async (options) => {
      if (matches(cached, options) && now() - cached.at < 3e4) return cached.target;
      if (matches(pending, options)) return pending.promise;
      const job = { token: options.token, channelId: options.channelId };
      pending = job;
      job.promise = Promise.resolve().then(() => resolve(options)).then((target) => {
        if (pending === job) cached = { token: job.token, channelId: job.channelId, target, at: now() };
        return target;
      }).finally(() => {
        if (pending === job) pending = null;
      });
      return job.promise;
    };
  }

  // src/utils/id-list.js
  function parseIdList(value, label = "IDs", { required = false } = {}) {
    const ids = [...new Set(String(value || "").split(",").map((id) => id.trim()).filter(Boolean))];
    if (required && !ids.length) throw new Error(`Enter at least one ${label}.`);
    if (ids.some((id) => !/^\d{15,22}$/.test(id))) throw new Error(`${label} must be Discord IDs separated by commas.`);
    return ids;
  }

  // src/ui/calendar.js
  function enhanceCalendars(panel) {
    let closeCurrent = () => {
    };
    const displayFormat = new Intl.DateTimeFormat(void 0, { dateStyle: "medium", timeStyle: "short" });
    const monthFormat = new Intl.DateTimeFormat(void 0, { month: "long", year: "numeric" });
    const dayFormat = new Intl.DateTimeFormat(void 0, { dateStyle: "full" });
    panel.querySelectorAll("input[type=datetime-local]").forEach((input) => {
      const label = input.parentElement.querySelector("label");
      label.htmlFor = input.id;
      label.id = `${input.id}-label`;
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "dmd-select-trigger";
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-labelledby", `${label.id} ${input.id}-display`);
      const text = document.createElement("span");
      text.id = `${input.id}-display`;
      trigger.append(text);
      input.classList.add("dmd-native-select");
      input.tabIndex = -1;
      input.after(trigger);
      const sync = () => {
        text.textContent = input.value ? displayFormat.format(new Date(input.value)) : "Choose date & time";
        trigger.disabled = input.disabled;
      };
      input.addEventListener("change", sync);
      sync();
      let picker, selected, month, heading, hours, minutes, apply, renderedMonth, selectedButton;
      const days = [], dates = [];
      const button = (name, action) => {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = name;
        node.onclick = action;
        return node;
      };
      const render = () => {
        const key = `${month.getFullYear()}-${month.getMonth()}`;
        if (key !== renderedMonth) {
          renderedMonth = key;
          heading.textContent = monthFormat.format(month);
          const offset = (month.getDay() + 6) % 7;
          for (let i = 0; i < days.length; i++) {
            const date = dates[i] = new Date(month.getFullYear(), month.getMonth(), i - offset + 1);
            const day = days[i];
            day.textContent = String(date.getDate());
            day.setAttribute("aria-label", dayFormat.format(date));
            day.classList.toggle("outside", date.getMonth() !== month.getMonth());
          }
        }
        const selectedDate = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate()).getTime();
        const nextSelected = days[dates.findIndex((date) => date.getTime() === selectedDate)];
        if (selectedButton !== nextSelected) {
          selectedButton?.classList.remove("selected");
          nextSelected?.classList.add("selected");
          selectedButton = nextSelected;
        }
      };
      const close = () => {
        picker?.remove();
        trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
        panel.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
        if (closeCurrent === close) closeCurrent = () => {
        };
      };
      const outside = (event) => {
        if (!picker.contains(event.target) && !trigger.contains(event.target)) close();
      };
      const createPicker = () => {
        picker = document.createElement("div");
        picker.className = "dmd-calendar";
        picker.setAttribute("role", "dialog");
        const header = document.createElement("div");
        header.className = "dmd-calendar-header";
        heading = document.createElement("span");
        const grid = document.createElement("div");
        grid.className = "dmd-calendar-grid";
        for (const day of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) {
          const span = document.createElement("span");
          span.textContent = day;
          grid.append(span);
        }
        for (let i = 0; i < 42; i++) {
          const day = button("", () => {
            selected = dates[i];
            render();
          });
          days.push(day);
          grid.append(day);
        }
        hours = document.createElement("input");
        hours.type = "number";
        hours.min = "0";
        hours.max = "23";
        hours.setAttribute("aria-label", "Hour");
        minutes = document.createElement("input");
        minutes.type = "number";
        minutes.min = "0";
        minutes.max = "59";
        minutes.setAttribute("aria-label", "Minute");
        const previous = button("\u2039", () => {
          month.setMonth(month.getMonth() - 1);
          render();
        });
        previous.setAttribute("aria-label", "Previous month");
        const next = button("\u203A", () => {
          month.setMonth(month.getMonth() + 1);
          render();
        });
        next.setAttribute("aria-label", "Next month");
        header.append(previous, heading, next);
        const time = document.createElement("div");
        time.className = "dmd-calendar-time";
        const timeLabel = document.createElement("span");
        timeLabel.textContent = "Time";
        time.append(timeLabel, hours, document.createTextNode(":"), minutes);
        const footer = document.createElement("div");
        footer.className = "dmd-calendar-footer";
        const clear = button("Clear", () => {
          input.value = "";
          input.dispatchEvent(new Event("change", { bubbles: true }));
          close();
          trigger.focus();
        });
        const cancel = button("Cancel", () => {
          close();
          trigger.focus();
        });
        apply = button("Apply", () => {
          if (!hours.value || !minutes.value || !hours.checkValidity() || !minutes.checkValidity()) {
            (!hours.checkValidity() || !hours.value ? hours : minutes).focus();
            return;
          }
          const pad = (value) => String(value).padStart(2, "0");
          input.value = `${selected.getFullYear()}-${pad(selected.getMonth() + 1)}-${pad(selected.getDate())}T${pad(hours.value)}:${pad(minutes.value)}`;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          close();
          trigger.focus();
        });
        footer.append(clear, cancel, apply);
        picker.append(header, grid, time, footer);
        picker.onkeydown = (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            trigger.focus();
          }
        };
      };
      trigger.onclick = () => {
        closeCurrent();
        sync();
        if (input.disabled) return;
        selected = input.value ? new Date(input.value) : /* @__PURE__ */ new Date();
        month = new Date(selected.getFullYear(), selected.getMonth(), 1);
        if (!picker) createPicker();
        picker.setAttribute("aria-label", label.textContent);
        hours.value = String(selected.getHours());
        minutes.value = String(selected.getMinutes());
        render();
        document.body.append(picker);
        const rect = trigger.getBoundingClientRect();
        picker.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 298))}px`;
        picker.style.top = `${Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - picker.offsetHeight - 8))}px`;
        trigger.setAttribute("aria-expanded", "true");
        document.addEventListener("pointerdown", outside, true);
        panel.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        closeCurrent = close;
        apply.focus();
      };
    });
  }

  // src/ui/select.js
  function enhanceSelects(panel) {
    let closeCurrent = () => {
    };
    panel.querySelectorAll("select:not([multiple])").forEach((select, index) => {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "dmd-select-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      const label = panel.querySelector(`label[for="${select.id}"]`);
      if (label) {
        label.id ||= `dmd-select-label-${index}`;
        trigger.setAttribute("aria-labelledby", `${label.id} ${select.id}-value`);
      } else trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "Choose option");
      const text = document.createElement("span");
      text.id = `${select.id}-value`;
      trigger.appendChild(text);
      select.classList.add("dmd-native-select");
      select.tabIndex = -1;
      select.insertAdjacentElement("afterend", trigger);
      const sync = () => {
        text.textContent = select.selectedOptions[0]?.textContent || "";
        trigger.disabled = select.disabled;
      };
      select.addEventListener("change", sync);
      sync();
      let menu, choices = [], available = [], active;
      const close = () => {
        menu?.remove();
        trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("resize", close);
        panel.removeEventListener("scroll", close, true);
        if (closeCurrent === close) closeCurrent = () => {
        };
      };
      const outside = (event) => {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
      };
      const focus = () => choices[active]?.focus();
      const open = () => {
        closeCurrent();
        sync();
        if (select.disabled) return;
        if (!menu) {
          menu = document.createElement("div");
          menu.className = "dmd-select-menu";
          menu.id = `${select.id}-menu`;
          menu.setAttribute("role", "listbox");
          trigger.setAttribute("aria-controls", menu.id);
          menu.onkeydown = (event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              close();
              trigger.focus();
              if (event.key === "Escape") event.preventDefault();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !available.length) return;
            event.preventDefault();
            const at = available.indexOf(active);
            active = event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1) : available[(at + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length];
            focus();
          };
        }
        menu.setAttribute("aria-label", label?.textContent || select.getAttribute("aria-label") || "Options");
        while (choices.length > select.options.length) choices.pop().remove();
        while (choices.length < select.options.length) {
          const optionIndex = choices.length;
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("role", "option");
          button.onclick = () => {
            select.value = select.options[optionIndex].value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            close();
            trigger.focus();
          };
          choices.push(button);
          menu.appendChild(button);
        }
        available = [];
        for (let i = 0; i < choices.length; i++) {
          const option = select.options[i], button = choices[i];
          if (button.textContent !== option.textContent) button.textContent = option.textContent;
          button.setAttribute("aria-selected", String(option.selected));
          button.disabled = option.disabled;
          if (!button.disabled) available.push(i);
        }
        document.body.appendChild(menu);
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
        menu.style.width = `${width}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
        const below = window.innerHeight - rect.bottom - 12;
        menu.style.top = "";
        menu.style.bottom = "";
        if (below >= 140) {
          menu.style.top = `${rect.bottom + 5}px`;
          menu.style.maxHeight = `${Math.min(280, below)}px`;
        } else {
          menu.style.bottom = `${window.innerHeight - rect.top + 5}px`;
          menu.style.maxHeight = `${Math.max(60, Math.min(280, rect.top - 12))}px`;
        }
        active = available.includes(select.selectedIndex) ? select.selectedIndex : available[0];
        trigger.setAttribute("aria-expanded", "true");
        focus();
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("resize", close);
        panel.addEventListener("scroll", close, true);
        closeCurrent = close;
      };
      trigger.onclick = open;
      trigger.onkeydown = (event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          open();
        }
      };
    });
  }

  // src/ui/identity-preview.js
  var pendingByCache = /* @__PURE__ */ new WeakMap();
  function installIdentityPreviews($, { author = "#dmd-author", guild = "#dmd-guild", userBadge = "#dmd-user-avatar", guildBadge = "#dmd-guild-avatar", cache = /* @__PURE__ */ new Map() } = {}) {
    const pending = pendingByCache.get(cache) || /* @__PURE__ */ new Map();
    pendingByCache.set(cache, pending);
    const remember = (key, value) => {
      cache.delete(key);
      cache.set(key, value);
      while (cache.size > 128) cache.delete(cache.keys().next().value);
    };
    const inputs = { user: author ? $(author) : null, guild: guild ? $(guild) : null };
    const badges = { user: userBadge ? $(userBadge) : null, guild: guildBadge ? $(guildBadge) : null };
    const tokenInput = $("#dmd-token");
    const badgeFor = (kind) => badges[kind];
    const versions = { user: 0, guild: 0 };
    const timers = {};
    const show = (kind, value, data) => {
      const badge = badgeFor(kind);
      badge.textContent = "";
      badge.hidden = false;
      const name = kind === "user" ? displayName(data) : data.name;
      const url = kind === "user" ? userIconUrl(data) : guildIconUrl(data);
      badge.title = name || value;
      badge.setAttribute("aria-label", name || value);
      badge.textContent = (name || "?").slice(0, 1).toUpperCase();
      if (url) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = name || (kind === "user" ? "User avatar" : "Server icon");
        image.onerror = () => image.remove();
        badge.appendChild(image);
      }
    };
    const refresh = async (kind) => {
      const input = inputs[kind];
      if (!input) return;
      const value = input.value.split(",")[0].trim(), version = ++versions[kind];
      const badge = badgeFor(kind);
      badge.hidden = true;
      badge.textContent = "";
      if (kind === "guild" && value === "@me") {
        badge.hidden = false;
        badge.textContent = "@";
        badge.title = "Direct messages";
        badge.setAttribute("aria-label", "Direct messages");
        return;
      }
      if (!/^\d{15,22}$/.test(value)) return;
      let data = cache.get(`${kind}:${value}`);
      if (!data && kind === "user") {
        try {
          data = users?.getUser?.(value);
        } catch {
        }
      }
      if (!data) {
        const token = tokenInput.value.trim();
        if (!token) return;
        const key = `${token}/${kind}:${value}`;
        const isCurrent = () => versions[kind] === version && input.value.split(",")[0].trim() === value && tokenInput.value.trim() === token;
        let request = pending.get(key);
        if (!request) {
          request = { readers: /* @__PURE__ */ new Set() };
          request.promise = Promise.resolve().then(async () => {
            const stopped = () => {
              for (const reader of request.readers) if (reader()) return false;
              return true;
            };
            const response = await apiFetch(`${API}/${kind === "user" ? "users" : "guilds"}/${value}`, { headers: { Authorization: token } }, () => {
            }, stopped);
            return response.ok ? response.json() : null;
          }).finally(() => {
            if (pending.get(key) === request) pending.delete(key);
          });
          pending.set(key, request);
        }
        request.readers.add(isCurrent);
        try {
          data = await request.promise;
        } catch {
          return;
        } finally {
          request.readers.delete(isCurrent);
        }
      }
      if (data?.id !== value || versions[kind] !== version || input.value.split(",")[0].trim() !== value) return;
      remember(`${kind}:${value}`, data);
      show(kind, value, data);
    };
    for (const kind of ["user", "guild"]) {
      const input = inputs[kind];
      if (!input) continue;
      input.addEventListener("input", () => {
        ++versions[kind];
        badgeFor(kind).hidden = true;
        clearTimeout(timers[kind]);
        timers[kind] = setTimeout(() => void refresh(kind), 400);
      });
      input.addEventListener("change", () => {
        clearTimeout(timers[kind]);
        void refresh(kind);
      });
    }
    tokenInput.addEventListener("change", () => {
      void refresh("user");
      void refresh("guild");
    });
    return { refresh, seedGuild: (server) => {
      if (server?.id) remember(`guild:${server.id}`, server);
    }, seedUser: (user) => {
      if (user?.id) remember(`user:${user.id}`, user);
    } };
  }

  // src/utils/insert-css.js
  function insertCss(css) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    return style;
  }

  // src/features/history/config.js
  var PAGE_SIZE = 10;
  var HISTORY_KEY = "del_discord_v1_history";
  var STATE_KEY = "del_discord_v1_history_state";

  // src/features/history/storage.js
  function loadHistory() {
    try {
      const parsed = JSON.parse(siteStorage().getItem(HISTORY_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function saveHistory(history) {
    try {
      siteStorage().setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.warn("[DM History] Save failed", e);
    }
  }
  function loadState() {
    try {
      const parsed = JSON.parse(siteStorage().getItem(STATE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function saveState(state) {
    try {
      const storage = siteStorage();
      const serialized = JSON.stringify(state);
      if (storage.getItem(STATE_KEY) !== serialized) storage.setItem(STATE_KEY, serialized);
    } catch (e) {
      console.warn("[DM History] State save failed", e);
    }
  }

  // src/discord/token.js
  var tokenGettersCache = null;
  function tokenGetters(forceRefresh = false) {
    if (tokenGettersCache && !forceRefresh) return tokenGettersCache;
    const getters = [];
    const seen = /* @__PURE__ */ new Set();
    try {
      const chunks = window.webpackChunkdiscord_app;
      if (chunks?.push) {
        const modules = [];
        chunks.push([[Math.random()], {}, (req) => {
          for (const k in req.c) modules.push(req.c[k]);
        }]);
        for (const mod of modules) {
          try {
            const exp = mod?.exports;
            const candidates = [exp, exp?.default];
            if (exp && typeof exp === "object") candidates.push(...Object.values(exp));
            for (const candidate of candidates) {
              const getter = candidate?.getToken;
              if (typeof getter === "function" && !seen.has(getter)) {
                seen.add(getter);
                getters.push(() => getter.call(candidate));
              }
            }
          } catch {
          }
        }
      }
    } catch {
    }
    tokenGettersCache = getters;
    return getters;
  }
  function tokenCandidates() {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (token) => {
      if (typeof token === "string" && token.length > 20 && !seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    };
    try {
      const storage = siteStorage();
      if (storage.token) add(JSON.parse(storage.token));
    } catch {
    }
    let getters = tokenGetters();
    for (const getter of getters) {
      try {
        add(getter());
      } catch {
      }
    }
    if (!out.length && getters.length) {
      getters = tokenGetters(true);
      for (const getter of getters) {
        try {
          add(getter());
        } catch {
        }
      }
    }
    return out;
  }

  // src/discord/history-auth.js
  var authCache = null;
  function invalidateAuth() {
    authCache = null;
  }
  async function identity() {
    const now = Date.now();
    if (authCache && now - authCache.at < AUTH_CACHE_TTL) return authCache.identity;
    for (const token of tokenCandidates()) {
      try {
        const r = await apiFetch(`${API}/users/@me`, { headers: { Authorization: token } });
        if (r.ok) {
          const identity2 = { token, user: await r.json() };
          authCache = { at: now, identity: identity2 };
          return identity2;
        }
      } catch {
      }
    }
    invalidateAuth();
    return null;
  }

  // src/features/history/model.js
  var historyIndexes = /* @__PURE__ */ new WeakMap();
  var revisions = /* @__PURE__ */ new WeakMap();
  var historyRevision = (map) => revisions.get(map) || 0;
  var changed = (map) => revisions.set(map, historyRevision(map) + 1);
  function indexesFor(map) {
    let indexes = historyIndexes.get(map);
    if (indexes) return indexes;
    indexes = {
      byUser: /* @__PURE__ */ new Map(),
      byChannel: /* @__PURE__ */ new Map()
    };
    for (const key of Object.keys(map)) {
      const value = map[key];
      if (value?.userId) indexes.byUser.set(value.userId, key);
      if (value?.channelId) indexes.byChannel.set(value.channelId, key);
    }
    historyIndexes.set(map, indexes);
    return indexes;
  }
  function merge(map, incoming) {
    const indexes = indexesFor(map);
    const userKey = incoming.userId ? indexes.byUser.get(incoming.userId) : "";
    const channelKey = incoming.channelId ? indexes.byChannel.get(incoming.channelId) : "";
    const oldKey = userKey || channelKey || "";
    const key = incoming.userId ? `u:${incoming.userId}` : incoming.channelId ? `c:${incoming.channelId}` : "";
    if (!key) return;
    const previous = oldKey ? map[oldKey] || {} : map[key] || {};
    const merged = {
      userId: incoming.userId || previous.userId || "",
      channelId: incoming.channelId || previous.channelId || "",
      name: incoming.name || previous.name || "",
      username: incoming.username || previous.username || "",
      avatar: incoming.avatar || previous.avatar || "",
      dmRank: Number.isFinite(incoming.dmRank) ? incoming.dmRank : Number.isFinite(previous.dmRank) ? previous.dmRank : null,
      sources: [.../* @__PURE__ */ new Set([...previous.sources || [], ...incoming.sources || []])],
      seenAt: incoming.seenAt || previous.seenAt || (/* @__PURE__ */ new Date()).toISOString(),
      sentCount: Math.max(
        Number.isFinite(previous.sentCount) ? previous.sentCount : 0,
        Number.isFinite(incoming.sentCount) ? incoming.sentCount : 0
      ),
      sentCountExact: incoming.sentCountExact === true || previous.sentCountExact === true,
      verifiedSent: incoming.verifiedSent === true || previous.verifiedSent === true
    };
    if (oldKey && oldKey !== key) delete map[oldKey];
    if (previous.userId && previous.userId !== merged.userId && indexes.byUser.get(previous.userId) === oldKey) indexes.byUser.delete(previous.userId);
    if (previous.channelId && previous.channelId !== merged.channelId && indexes.byChannel.get(previous.channelId) === oldKey) indexes.byChannel.delete(previous.channelId);
    map[key] = merged;
    if (merged.userId) indexes.byUser.set(merged.userId, key);
    if (merged.channelId) indexes.byChannel.set(merged.channelId, key);
    changed(map);
    return merged;
  }
  function removeHistoryMatch(map, userId, channelId) {
    const indexes = indexesFor(map);
    const keys = /* @__PURE__ */ new Set();
    if (userId) {
      const key = indexes.byUser.get(userId);
      if (key) keys.add(key);
    }
    if (channelId) {
      const key = indexes.byChannel.get(channelId);
      if (key) keys.add(key);
    }
    for (const key of keys) {
      const value = map[key];
      if (!value) continue;
      if (value.userId) indexes.byUser.delete(value.userId);
      if (value.channelId) indexes.byChannel.delete(value.channelId);
      delete map[key];
      changed(map);
    }
  }
  function recipientIds(obj, out = []) {
    if (typeof obj === "string" && /^\d{15,22}$/.test(obj)) out.push(obj);
    else if (Array.isArray(obj)) obj.forEach((v) => recipientIds(v, out));
    else if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) if (/recipient|user|member|participant/i.test(k)) recipientIds(v, out);
    }
    return out;
  }

  // src/features/history/view.js
  function createHistoryView() {
    let previousMap, previousRevision = -1, sorted = [], filtered = [];
    let previousQuery = null;
    const searchText = /* @__PURE__ */ new WeakMap();
    return (history, query = "") => {
      const revision = historyRevision(history);
      if (history !== previousMap || revision !== previousRevision) {
        sorted = [];
        for (const key of Object.keys(history)) {
          const entry = history[key];
          if (entry?.verifiedSent === true && Number(entry.sentCount || 0) > 0) sorted.push(entry);
        }
        sorted.sort((a, b) => {
          const ar = Number.isFinite(a.dmRank) ? a.dmRank : 1e12;
          const br = Number.isFinite(b.dmRank) ? b.dmRank : 1e12;
          return ar - br || (a.name || a.username || a.userId || a.channelId).localeCompare(b.name || b.username || b.userId || b.channelId);
        });
        previousMap = history;
        previousRevision = revision;
        previousQuery = null;
      }
      const normalized = query.trim().toLowerCase();
      if (normalized !== previousQuery) {
        filtered = normalized ? sorted.filter((entry) => {
          let text = searchText.get(entry);
          if (text === void 0) {
            text = [entry.name, entry.username, entry.userId, entry.channelId].join(" ").toLowerCase();
            searchText.set(entry, text);
          }
          return text.includes(normalized);
        }) : sorted;
        previousQuery = normalized;
      }
      return filtered;
    };
  }

  // src/features/history/verify.js
  async function sentCountForChannel(token, selfId, channelId) {
    while (true) {
      const query = new URLSearchParams({ author_id: selfId, sort_by: "timestamp", sort_order: "desc", offset: "0" });
      const r = await apiFetch(`${API}/channels/${channelId}/messages/search?${query.toString()}`, { headers: { Authorization: token } });
      if (r.status === 202) {
        let body = {};
        try {
          body = await r.json();
        } catch {
        }
        await sleep(retryMs(body.retry_after ?? 1) + 250);
        continue;
      }
      if (!r.ok) return null;
      const data = await r.json();
      return Number(data.total_results || 0);
    }
  }
  async function closeTemporaryDm(token, channelId) {
    try {
      const response = await apiFetch(`${API}/channels/${channelId}`, { method: "DELETE", headers: { Authorization: token } });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      throw new Error(`Could not close the temporarily opened DM. It may remain open in your DM list. ${error.message || error}`, { cause: error });
    }
  }
  async function verifyPerson(token, selfId, userId, knownChannelId, wasOpen) {
    let channelId = knownChannelId || "";
    let temporarilyOpened = false;
    try {
      if (!channelId) {
        const r = await apiFetch(`${API}/users/@me/channels`, {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ recipient_id: userId })
        });
        if (!r.ok) return null;
        const ch = await r.json();
        channelId = ch?.id || "";
        temporarilyOpened = !!channelId && !wasOpen;
      }
      if (!channelId) return null;
      const count = await sentCountForChannel(token, selfId, channelId);
      return { count, channelId };
    } finally {
      if (temporarilyOpened && channelId) await closeTemporaryDm(token, channelId);
    }
  }

  // src/features/history/count-csv.js
  async function countCsvMessages(file) {
    let quoted = false, hasData = false, records = 0;
    const consume = (text) => {
      for (let index = 0; index < text.length; index++) {
        const character = text.charCodeAt(index);
        if (character === 34) quoted = !quoted;
        if (!quoted && (character === 10 || character === 13)) {
          if (hasData) records++;
          hasData = false;
        } else if (character > 32 && character !== 65279) hasData = true;
      }
    };
    if (typeof file.stream === "function") {
      const reader = file.stream().getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.length; offset += 64 * 1024) {
            consume(decoder.decode(value.subarray(offset, offset + 64 * 1024), { stream: true }));
          }
        }
        consume(decoder.decode());
      } finally {
        reader.releaseLock();
      }
    } else consume(await file.text());
    if (hasData) records++;
    return Math.max(0, records - 1);
  }

  // src/features/history/count-json.js
  var SMALL_JSON_LIMIT = 64 * 1024;
  var parsedCount = (text) => {
    const data = JSON.parse(text || "[]");
    return Array.isArray(data) ? data.length : Array.isArray(data?.messages) ? data.messages.length : data && typeof data === "object" && Object.keys(data).length ? 1 : 0;
  };
  async function countJsonMessages(file) {
    if (Number.isFinite(file.size) && file.size <= SMALL_JSON_LIMIT && typeof file.text === "function") return parsedCount(await file.text());
    let fallbackText;
    if (typeof file.stream !== "function") {
      fallbackText = await file.text() || "[]";
      if (fallbackText.length <= SMALL_JSON_LIMIT) return parsedCount(fallbackText);
    }
    const stack = [];
    const frames = [];
    const stringMarker = /["\\\x00-\x1f]/g;
    let rootState = "value", rootType = "", rootFields = 0, result = 0;
    let messagesCount = null, token = "", literal = "", literalIndex = 0;
    let escape = false, unicode = 0, unicodeValue = 0, sawInput = false;
    let key = false, keyMatch = true, keyLength = 0;
    const fail = () => {
      throw new SyntaxError("Invalid message JSON.");
    };
    const frame = () => stack[stack.length - 1];
    const acceptValue = (type) => {
      const parent = frame();
      if (!parent) {
        if (rootState !== "value") fail();
        rootState = "end";
        rootType = type;
      } else if (parent.type === "array") {
        if (parent.state !== "first" && parent.state !== "value") fail();
        parent.state = "comma";
        parent.count++;
      } else {
        if (parent.state !== "value") fail();
        parent.state = "comma";
        if (stack.length === 1 && parent.messagesKey) messagesCount = null;
      }
    };
    const emitKeyCharacter = (character) => {
      if (key) {
        if (character !== "messages".charCodeAt(keyLength)) keyMatch = false;
        keyLength++;
      }
    };
    const numberCharacter = (character) => {
      const digit = character >= 48 && character <= 57;
      switch (token) {
        case "minus":
          if (character === 48) token = "zero";
          else if (digit) token = "integer";
          else fail();
          break;
        case "zero":
          if (character === 46) token = "dot";
          else if (character === 69 || character === 101) token = "exponent";
          else return false;
          break;
        case "integer":
          if (digit) break;
          if (character === 46) token = "dot";
          else if (character === 69 || character === 101) token = "exponent";
          else return false;
          break;
        case "dot":
          if (!digit) fail();
          token = "fraction";
          break;
        case "fraction":
          if (digit) break;
          if (character === 69 || character === 101) token = "exponent";
          else return false;
          break;
        case "exponent":
          if (character === 43 || character === 45) token = "exponentSign";
          else if (digit) token = "exponentDigits";
          else fail();
          break;
        case "exponentSign":
          if (!digit) fail();
          token = "exponentDigits";
          break;
        case "exponentDigits":
          if (!digit) return false;
          break;
      }
      return true;
    };
    const consume = (text) => {
      if (text.length) sawInput = true;
      for (let i = 0; i < text.length; i++) {
        let character = text.charCodeAt(i);
        if (token === "string") {
          if ((!key || stack.length > 1) && !escape && !unicode) {
            stringMarker.lastIndex = i;
            if (!stringMarker.test(text)) break;
            i = stringMarker.lastIndex - 1;
            character = text.charCodeAt(i);
          }
          if (unicode) {
            const digit = character >= 48 && character <= 57 ? character - 48 : character >= 65 && character <= 70 ? character - 55 : character >= 97 && character <= 102 ? character - 87 : -1;
            if (digit < 0) fail();
            unicodeValue = unicodeValue * 16 + digit;
            if (--unicode === 0) emitKeyCharacter(unicodeValue);
          } else if (escape) {
            escape = false;
            if (character === 117) {
              unicode = 4;
              unicodeValue = 0;
            } else {
              if (![34, 92, 47, 98, 102, 110, 114, 116].includes(character)) fail();
              emitKeyCharacter(character === 98 ? 8 : character === 102 ? 12 : character === 110 ? 10 : character === 114 ? 13 : character === 116 ? 9 : character);
            }
          } else if (character === 92) escape = true;
          else if (character === 34) {
            token = "";
            if (key) {
              const parent2 = frame();
              parent2.state = "colon";
              parent2.messagesKey = keyMatch && keyLength === 8;
              if (stack.length === 1) rootFields++;
            }
            key = false;
          } else {
            if (character < 32) fail();
            emitKeyCharacter(character);
          }
          continue;
        }
        if (token === "literal") {
          if (character !== literal.charCodeAt(literalIndex++)) fail();
          if (literalIndex === literal.length) token = "";
          continue;
        }
        if (token) {
          if (numberCharacter(character)) continue;
          token = "";
        }
        if (character === 32 || character === 9 || character === 10 || character === 13) continue;
        const parent = frame();
        if (character === 34) {
          key = !!parent && parent.type === "object" && (parent.state === "first" || parent.state === "key");
          if (key) {
            keyMatch = true;
            keyLength = 0;
          } else acceptValue("string");
          token = "string";
        } else if (character === 91 || character === 123) {
          const type = character === 91 ? "array" : "object";
          const messages = stack.length === 1 && parent.type === "object" && parent.messagesKey && type === "array";
          acceptValue(type);
          const nested = frames[stack.length] || (frames[stack.length] = {});
          nested.type = type;
          nested.state = "first";
          nested.count = 0;
          nested.messages = messages;
          nested.messagesKey = false;
          stack.push(nested);
        } else if (character === 93 || character === 125) {
          if (!parent || parent.type !== (character === 93 ? "array" : "object") || parent.state !== "first" && parent.state !== "comma") fail();
          stack.pop();
          if (parent.messages) messagesCount = parent.count;
          if (!stack.length && parent.type === "array") result = parent.count;
        } else if (character === 44) {
          if (!parent || parent.state !== "comma") fail();
          parent.state = parent.type === "array" ? "value" : "key";
        } else if (character === 58) {
          if (!parent || parent.type !== "object" || parent.state !== "colon") fail();
          parent.state = "value";
        } else if (character === 116 || character === 102 || character === 110) {
          acceptValue("literal");
          token = "literal";
          literal = character === 116 ? "true" : character === 102 ? "false" : "null";
          literalIndex = 1;
        } else if (character === 45 || character >= 48 && character <= 57) {
          acceptValue("number");
          token = character === 45 ? "minus" : character === 48 ? "zero" : "integer";
        } else fail();
      }
    };
    if (typeof file.stream === "function") {
      const reader = file.stream().getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let finished = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.length; offset += SMALL_JSON_LIMIT) {
            consume(decoder.decode(value.subarray(offset, offset + SMALL_JSON_LIMIT), { stream: true }));
          }
        }
        consume(decoder.decode());
        finished = true;
      } finally {
        if (!finished) {
          try {
            await reader.cancel();
          } catch {
          }
        }
        reader.releaseLock();
      }
    } else consume(fallbackText);
    if (!sawInput) return 0;
    if (stack.length || rootState !== "end" || token && !["zero", "integer", "fraction", "exponentDigits"].includes(token)) fail();
    return rootType === "array" ? result : rootType === "object" ? messagesCount ?? (rootFields ? 1 : 0) : 0;
  }

  // src/features/history/import-package.js
  async function importPackage(fileList, { $, getHistory, getIdentity, setPackageInfo, persist, render }) {
    const history = getHistory();
    const isCurrent = () => getHistory() === history;
    const files = [...fileList || []];
    if (!files.length) return;
    $("#dmh-import").disabled = true;
    $("#dmh-summary").textContent = `Indexing ${files.length} package files locally\u2026`;
    try {
      const me = await getIdentity();
      if (!isCurrent()) return;
      const selfId = me?.user?.id || "";
      const pathOf = (file) => String(file.webkitRelativePath || file.name).replace(/\\/g, "/");
      const folderOf = (path) => path.slice(0, path.lastIndexOf("/")).toLowerCase();
      const index = /* @__PURE__ */ new Map();
      const channelFiles = [];
      const messageFilesByFolder = /* @__PURE__ */ new Map();
      for (const file of files) {
        if (!isCurrent()) return;
        const path = pathOf(file);
        const lower = path.toLowerCase();
        if (`/${lower}`.endsWith("/messages/index.json")) {
          try {
            const obj = JSON.parse(await file.text());
            if (!isCurrent()) return;
            for (const [id, label] of Object.entries(obj || {})) {
              if (typeof label === "string") index.set(String(id), label);
            }
          } catch {
          }
          continue;
        }
        if (`/${lower}`.endsWith("/channel.json")) {
          channelFiles.push({ file, path });
          continue;
        }
        if (/\/messages(?:\.csv|\.json)$/.test("/" + lower)) {
          const folder = folderOf(path);
          const bucket = messageFilesByFolder.get(folder);
          if (bucket) bucket.push({ file, lower });
          else messageFilesByFolder.set(folder, [{ file, lower }]);
        }
      }
      const sentCountsByFolder = /* @__PURE__ */ new Map();
      const countSentMessages = async (folder) => {
        const key = folder.toLowerCase();
        if (sentCountsByFolder.has(key)) return sentCountsByFolder.get(key);
        const msgFiles = messageFilesByFolder.get(key) || [];
        let total = 0;
        for (const { file, lower } of msgFiles) {
          try {
            if (lower.endsWith(".json")) {
              total += await countJsonMessages(file);
            } else total += await countCsvMessages(file);
          } catch {
            sentCountsByFolder.set(key, null);
            return null;
          }
        }
        sentCountsByFolder.set(key, total);
        return total;
      };
      let importedCount = 0;
      let processed = 0;
      let lastSavedAt = Date.now();
      for (const { file, path } of channelFiles) {
        if (!isCurrent()) return;
        processed++;
        if (processed % 25 === 0) {
          $("#dmh-summary").textContent = `Processing package conversations ${processed}/${channelFiles.length}\u2026`;
          await new Promise(requestAnimationFrame);
          if (!isCurrent()) return;
        }
        let ch;
        try {
          ch = JSON.parse(await file.text());
        } catch {
          continue;
        }
        if (!isCurrent()) return;
        const folder = path.slice(0, path.lastIndexOf("/"));
        const channelId = String(ch?.id || folder.match(/(?:^|\/)c?(\d{15,22})$/)?.[1] || "");
        const label = index.get(channelId) || "";
        const type = String(ch?.type ?? "").toUpperCase();
        const direct = type === "DM" || type === "1" || /^Direct Message with /i.test(label);
        const group = type === "GROUP_DM" || type === "3";
        if (!direct || group) continue;
        const count = await countSentMessages(folder);
        if (!isCurrent()) return;
        if (count === null) continue;
        if (count <= 0) {
          removeHistoryMatch(history, "", channelId);
          continue;
        }
        const ids = [...new Set(recipientIds(ch))].filter((id) => id !== selfId && id !== channelId);
        merge(history, {
          userId: ids[0] || "",
          channelId,
          name: label.replace(/^Direct Message with\s+/i, "").trim(),
          sources: ["package"],
          sentCount: count,
          sentCountExact: false,
          verifiedSent: true,
          seenAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        importedCount++;
        if (Date.now() - lastSavedAt >= 2e3) {
          saveHistory(history);
          lastSavedAt = Date.now();
        }
      }
      if (!isCurrent()) return;
      saveHistory(history);
      setPackageInfo({
        importedAt: (/* @__PURE__ */ new Date()).toISOString(),
        importedCount,
        fileCount: files.length
      });
      persist();
      render();
      $("#dmh-summary").textContent = `Imported/updated ${importedCount} DM conversations. Parsed package results are cached locally.`;
    } finally {
      $("#dmh-import").disabled = false;
      $("#dmh-folder").value = "";
    }
  }

  // src/ui/confirm.js
  function askPopup({ title = "Confirm", message = "", details = "", yesText = "Yes", noText = "No", danger = false, render, getResult, onNo, signal } = {}) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "dmd-confirm-overlay";
      const box = document.createElement("div");
      box.className = "dmd-confirm-box";
      const heading = document.createElement("div");
      heading.className = "dmd-confirm-title";
      heading.textContent = title;
      const body = document.createElement("div");
      body.className = "dmd-confirm-message";
      body.textContent = message;
      box.append(heading, body);
      if (details) {
        const pre = document.createElement("pre");
        pre.className = "dmd-confirm-details";
        pre.textContent = details;
        box.appendChild(pre);
      }
      const actions = document.createElement("div");
      actions.className = "dmd-confirm-actions";
      const no = document.createElement("button");
      no.className = "dmd-btn";
      no.textContent = noText;
      const yes = document.createElement("button");
      yes.className = `dmd-btn ${danger ? "dmd-red" : "dmd-green"}`;
      yes.textContent = yesText;
      render?.({ box, yes });
      actions.append(no, yes);
      box.appendChild(actions);
      overlay.appendChild(box);
      const previousFocus = document.activeElement;
      const host = document.getElementById("dmd-panel") || document.body;
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      heading.id = "dmd-confirm-heading";
      box.setAttribute("aria-labelledby", heading.id);
      host.appendChild(overlay);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        signal?.removeEventListener("abort", onAbort);
        overlay.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(value && getResult ? getResult() : value);
      };
      const onKey = (e) => {
        if (e.key !== "Tab" && e.key !== "Escape" && !(e.key === "Enter" && (e.metaKey || e.ctrlKey))) return;
        const dialogs = document.querySelectorAll(".dmd-confirm-overlay");
        if (dialogs[dialogs.length - 1] !== overlay) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Tab") {
          const controls = [...box.querySelectorAll('button,input,select,[tabindex="0"]')].filter((node) => !node.disabled);
          const index = controls.indexOf(document.activeElement);
          controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
        }
        if (e.key === "Escape") finish(false);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !yes.disabled) finish(true);
      };
      const onAbort = () => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      no.onclick = () => {
        onNo?.();
        finish(false);
      };
      yes.onclick = () => {
        if (!yes.disabled) finish(true);
      };
      overlay.onclick = (e) => {
        if (e.target === overlay) finish(false);
      };
      document.addEventListener("keydown", onKey, true);
      yes.focus();
    });
  }

  // src/ui/history.html
  var history_default = '<div id="dmh-tools">\n<input id="dmh-search" aria-label="Search DM history" type="search" placeholder="Search name, username, user ID, or channel ID">\n<button id="dmh-refresh" class="dmh-button blue">Refresh & Verify</button>\n<button id="dmh-import" class="dmh-button">Import Data Package</button>\n<button id="dmh-clear" class="dmh-button red">Clear Saved</button>\n<button id="dmh-delete-all" class="dmh-button red" hidden>Delete All</button><button id="dmh-stop" class="dmh-button" disabled hidden>Stop</button>\n<input id="dmh-folder" type="file" webkitdirectory directory multiple>\n</div>\n<div id="dmh-summary">Loading saved history\u2026</div><div id="dmh-list"></div>\n<div id="dmh-footer">\n<button id="dmh-prev" class="dmh-button">Previous</button><span id="dmh-page">Page 1</span>\n<input id="dmh-page-input" aria-label="History page" type="number" min="1" value="1"><button id="dmh-page-go" class="dmh-button">Go</button>\n<button id="dmh-next" class="dmh-button">Next</button>\n</div>\n';

  // src/ui/history.css
  var history_default2 = '#dmd-panel #dmh-panel {\n  flex: 1;\n  min-height: 0;\n  flex-direction: column;\n  gap: 14px;\n  overflow: hidden;\n}\n#dmh-tools {\n  display: flex;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n#dmh-search {\n  flex: 1 0 100%;\n  height: 38px;\n  background: #3a3a39;\n  color: #eeeeea;\n  border: 1px solid #50504d;\n  border-radius: 4px;\n  padding: 8px 11px;\n}\n.dmh-button {\n  border: 1px solid #545450;\n  border-radius: 4px;\n  padding: 9px 12px;\n  background: #414140;\n  color: #eeeeea;\n  font: 600 12px/1.4 Arial, sans-serif;\n  cursor: pointer;\n}\n.dmh-button:hover:not(:disabled) {\n  filter: brightness(1.15);\n}\n.dmh-button:disabled {\n  opacity: .4;\n  cursor: default;\n}\n.dmh-button.green,\n.dmh-button.blue {\n  background: #eeeeea;\n  border-color: #eeeeea;\n}\n.dmh-button.red {\n  background: #3b2524;\n  border-color: #60302c;\n  color: #e99792;\n}\n#dmh-summary {\n  color: #a0a09a;\n  font-size: 12px;\n}\n#dmh-list {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  background: #343433;\n  border: 1px solid #ffffff13;\n  border-radius: 4px;\n  padding: 4px;\n}\n.dmh-row {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 12px;\n  border-bottom: 1px solid #ffffff13;\n  min-height: 68px;\n}\n.dmh-row:last-child {\n  border-bottom: 0;\n}\n.dmh-av,\n.dmh-fallback {\n  width: 38px;\n  height: 38px;\n  border-radius: 50%;\n  flex: 0 0 38px;\n}\n.dmh-av {\n  object-fit: cover;\n}\n.dmh-fallback {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: #eeeeea;\n  font-weight: 700;\n}\n.dmh-main {\n  flex: 1;\n  min-width: 0;\n}\n.dmh-name {\n  font-size: 14px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.dmh-sub {\n  font-size: 11px;\n  color: #a0a09a;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  margin-top: 3px;\n}\n.dmh-badges {\n  display: flex;\n  gap: 5px;\n  flex-wrap: wrap;\n  margin-top: 6px;\n}\n.dmh-badge {\n  font-size: 10px;\n  padding: 2px 6px;\n  border-radius: 4px;\n  background: #2a2a28;\n  color: #aaa9a5;\n}\n#dmh-footer {\n  border-top: 1px solid #ffffff13;\n  padding-top: 14px;\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  justify-content: center;\n  flex-wrap: wrap;\n  font-size: 12px;\n}\n#dmh-page {\n  color: #aaa9a5;\n}\n#dmh-page-input {\n  width: 56px;\n  height: 34px;\n  background: #3a3a39;\n  color: #eeeeea;\n  border: 1px solid #50504d;\n  border-radius: 4px;\n  padding: 4px;\n  text-align: center;\n}\n#dmh-folder {\n  display: none;\n}\n#dmh-panel .dmd-view-title {\n  margin-bottom: 5px;\n}\n#dmh-search {\n  font: inherit;\n}\n#dmh-list {\n  min-height: 100px;\n}\n.dmh-row:hover {\n  background: #ffffff04;\n}\n.dmh-button {\n  font-weight: 500;\n  font-family: inherit;\n}\n.dmh-confirm-box {\n  font:\n    14px/1.5 -apple-system,\n    BlinkMacSystemFont,\n    "Segoe UI",\n    sans-serif;\n}\n.dmh-button.green,\n.dmh-button.blue {\n  color: #2c2c2b;\n}\n#dmh-summary:empty {\n  display: none;\n}\n.dmh-select {\n  width: 15px;\n  height: 15px;\n  flex: none;\n  margin: 0;\n  accent-color: #8b85ed;\n  cursor: pointer;\n}\n';

  // src/ui/history.js
  function initHistory(container, { deleteConversations = async () => [] } = {}) {
    if (document.getElementById("dmh-panel")) return;
    insertCss(history_default2);
    const panel = document.createElement("div");
    panel.id = "dmh-panel";
    panel.className = "dmd-view";
    panel.style.display = "none";
    panel.innerHTML = history_default;
    container.insertBefore(panel, container.querySelector("#dmd-progress-dock"));
    const domCache = /* @__PURE__ */ new Map();
    const $ = (q) => {
      if (domCache.has(q)) return domCache.get(q);
      const node = panel.querySelector(q);
      domCache.set(q, node);
      return node;
    };
    let history = loadHistory();
    const selected = /* @__PURE__ */ new Set();
    let deleting = false;
    const selectionKey = (entry) => entry.channelId || entry.userId;
    const updateSelection = () => {
      $("#dmh-delete-all").hidden = selected.size === 0;
      $("#dmh-delete-all").textContent = `Delete All (${selected.size})`;
    };
    const stored = loadState();
    let page = Number.isInteger(stored.page) ? Math.max(0, stored.page) : 0;
    let query = typeof stored.query === "string" ? stored.query : "";
    let packageInfo = stored.packageInfo && typeof stored.packageInfo === "object" ? stored.packageInfo : null;
    let me = null, visible = [], resolving = false, resolvePending = false, refreshing = false;
    const nameAttempts = /* @__PURE__ */ new WeakMap();
    const historyView = createHistoryView();
    $("#dmh-search").value = query;
    const persist = () => saveState({ page, query, packageInfo });
    const sourceName = (s) => ({ open: "Open DM", affinity: "Closed/cache", package: "Data Package" })[s] || s;
    function filteredItems() {
      return historyView(history, query);
    }
    async function resolveVisibleUsers() {
      if (resolving) {
        resolvePending = true;
        return;
      }
      resolving = true;
      resolvePending = false;
      const resolvingHistory = history;
      const resolvingVisible = visible;
      try {
        let changed2 = false;
        for (const entry of resolvingVisible) {
          if (history !== resolvingHistory) break;
          if (!visible.includes(entry) || !entry.userId || entry.name && entry.username) continue;
          const attemptedAt = nameAttempts.get(entry);
          if (attemptedAt !== void 0 && Date.now() - attemptedAt < 6e4) continue;
          nameAttempts.set(entry, Date.now());
          let user = null;
          let remoteLookup = false;
          try {
            user = users?.getUser?.(entry.userId) || null;
          } catch {
          }
          if (!user) {
            if (!me) me = await identity();
            if (!me || history !== resolvingHistory) break;
            remoteLookup = true;
            try {
              const r = await apiFetch(`${API}/users/${entry.userId}`, { headers: { Authorization: me.token } });
              if (r.ok) user = await r.json();
            } catch {
            }
          }
          if (history !== resolvingHistory) break;
          if (user) {
            const resolved = merge(history, { userId: entry.userId, name: displayName(user), username: usernameOf(user), avatar: avatarUrl(user), seenAt: (/* @__PURE__ */ new Date()).toISOString() });
            nameAttempts.set(resolved, Date.now());
            changed2 = true;
          }
          if (remoteLookup) await sleep(50);
        }
        if (changed2 && history === resolvingHistory) {
          saveHistory(history);
          render(false);
        }
      } finally {
        resolving = false;
        if (resolvePending) void resolveVisibleUsers();
      }
    }
    function render(resolveNames = true) {
      const all = filteredItems();
      const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      page = Math.max(0, Math.min(page, pages - 1));
      persist();
      visible = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      const list = $("#dmh-list");
      list.textContent = "";
      const fragment = document.createDocumentFragment();
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.style.cssText = "padding:28px;text-align:center;color:#949ba4";
        empty.textContent = query ? "No matches." : "No verified sent-DM history yet. Press Refresh & Verify or import your Discord Data Package.";
        fragment.appendChild(empty);
      }
      for (const entry of visible) {
        const row = document.createElement("div");
        row.className = "dmh-row";
        let av;
        if (entry.avatar) {
          av = document.createElement("img");
          av.className = "dmh-av";
          av.src = entry.avatar;
          av.alt = "";
        } else {
          av = document.createElement("div");
          av.className = "dmh-fallback";
          av.textContent = (entry.name || entry.username || "?").charAt(0).toUpperCase();
        }
        const main = document.createElement("div");
        main.className = "dmh-main";
        const nm = document.createElement("div");
        nm.className = "dmh-name";
        nm.textContent = entry.name || entry.username || (entry.userId ? `User ${entry.userId}` : `DM Channel ${entry.channelId}`);
        const sub = document.createElement("div");
        sub.className = "dmh-sub";
        sub.textContent = [entry.username && entry.username !== entry.name ? entry.username : "", entry.userId ? `User ID: ${entry.userId}` : "", entry.channelId ? `Channel: ${entry.channelId}` : ""].filter(Boolean).join(" \u2022 ");
        const badges = document.createElement("div");
        badges.className = "dmh-badges";
        for (const source of entry.sources || []) {
          const b = document.createElement("span");
          b.className = "dmh-badge";
          b.textContent = sourceName(source);
          badges.appendChild(b);
        }
        const count = document.createElement("span");
        count.className = "dmh-badge";
        count.textContent = entry.cleanupFinishedAt ? "Cleanup finished \xB7 refresh to verify" : entry.sentCountExact ? `You sent ${entry.sentCount}` : `You sent ${entry.sentCount}+`;
        badges.appendChild(count);
        main.append(nm, sub, badges);
        const actions = document.createElement("div");
        if (entry.userId) {
          const open = document.createElement("button");
          open.className = "dmh-button green";
          open.textContent = "Open DM";
          open.onclick = async () => {
            const openingHistory = history;
            try {
              const currentIdentity = me || await identity();
              if (history !== openingHistory) return;
              me = currentIdentity;
              if (!me) return alert("Could not get a valid Discord authorization token.");
              const r = await apiFetch(`${API}/users/@me/channels`, { method: "POST", headers: { Authorization: me.token, "Content-Type": "application/json" }, body: JSON.stringify({ recipient_id: entry.userId }) });
              if (history !== openingHistory) return;
              if (!r.ok) return alert(`Discord could not reopen this DM (HTTP ${r.status}).`);
              const ch = await r.json();
              if (history !== openingHistory) return;
              merge(history, { userId: entry.userId, channelId: ch.id, sources: ["open"], sentCount: entry.sentCount, sentCountExact: entry.sentCountExact, verifiedSent: true, seenAt: (/* @__PURE__ */ new Date()).toISOString() });
              saveHistory(history);
              location.href = `/channels/@me/${ch.id}`;
            } catch (error) {
              if (history === openingHistory) alert(`Discord could not reopen this DM: ${error?.message || error}`);
            }
          };
          actions.appendChild(open);
        }
        const select = document.createElement("input");
        select.type = "checkbox";
        select.className = "dmh-select";
        select.checked = selected.has(selectionKey(entry));
        select.disabled = deleting;
        select.setAttribute("aria-label", `Select ${entry.name || entry.username || entry.channelId || entry.userId}`);
        select.onchange = () => {
          if (select.checked) selected.add(selectionKey(entry));
          else selected.delete(selectionKey(entry));
          updateSelection();
        };
        row.append(select, av, main, actions);
        fragment.appendChild(row);
      }
      list.appendChild(fragment);
      updateSelection();
      $("#dmh-page").textContent = `Page ${page + 1} of ${pages}`;
      $("#dmh-prev").disabled = page === 0;
      $("#dmh-next").disabled = page >= pages - 1;
      $("#dmh-page-input").max = String(pages);
      $("#dmh-page-input").value = String(page + 1);
      $("#dmh-summary").textContent = "";
      if (resolveNames) void resolveVisibleUsers();
    }
    async function refreshLive() {
      if (refreshing) return;
      refreshing = true;
      $("#dmh-refresh").disabled = true;
      $("#dmh-summary").textContent = "Loading Discord DM data\u2026";
      const refreshingHistory = history;
      let dirty = 0;
      try {
        const refreshedIdentity = await identity();
        if (history !== refreshingHistory) return;
        me = refreshedIdentity;
        if (!me) {
          $("#dmh-summary").textContent = "Could not get a valid Discord authorization token.";
          return;
        }
        const openByUser = /* @__PURE__ */ new Map();
        const r = await apiFetch(`${API}/users/@me/channels`, { headers: { Authorization: me.token } });
        if (history !== refreshingHistory) return;
        if (!r.ok) throw new Error(`Could not load open DMs (HTTP ${r.status}).`);
        const channels = await r.json();
        if (history !== refreshingHistory) return;
        for (const ch of Array.isArray(channels) ? channels : []) {
          if (ch?.type !== 1) continue;
          const u = ch.recipients?.find?.((v) => v?.id && v.id !== me.user.id);
          if (u) openByUser.set(u.id, { channelId: ch.id, user: u });
        }
        const candidates = /* @__PURE__ */ new Map();
        for (const [userId, data] of openByUser) candidates.set(userId, { userId, channelId: data.channelId, user: data.user, wasOpen: true, dmRank: null, source: "open" });
        for (const a of affinityEntries().filter((a2) => a2?.otherUserId && a2.otherUserId !== me.user.id && Number.isFinite(a2.dmRank) && a2.dmRank >= 0)) {
          const existing = candidates.get(a.otherUserId);
          if (existing) existing.dmRank = a.dmRank;
          else candidates.set(a.otherUserId, { userId: a.otherUserId, channelId: "", user: null, wasOpen: false, dmRank: a.dmRank, source: "affinity" });
        }
        const all = [...candidates.values()];
        let done = 0;
        for (const c of all) {
          if (history !== refreshingHistory) return;
          done++;
          $("#dmh-summary").textContent = `Verifying sent-message history ${done}/${all.length}\u2026`;
          const result = await verifyPerson(me.token, me.user.id, c.userId, c.channelId, c.wasOpen);
          if (history !== refreshingHistory) return;
          if (!result || result.count === null) {
            await sleep(200);
            continue;
          }
          if (result.count <= 0) {
            removeHistoryMatch(history, c.userId, result.channelId || c.channelId);
            dirty++;
          } else {
            let user = c.user;
            if (!user) {
              try {
                user = users?.getUser?.(c.userId) || null;
              } catch {
              }
            }
            merge(history, {
              userId: c.userId,
              channelId: result.channelId || c.channelId,
              name: displayName(user),
              username: usernameOf(user),
              avatar: avatarUrl(user),
              dmRank: c.dmRank,
              sources: [c.source],
              sentCount: result.count,
              sentCountExact: true,
              cleanupFinishedAt: null,
              verifiedSent: true,
              seenAt: (/* @__PURE__ */ new Date()).toISOString()
            });
            dirty++;
          }
          if (dirty >= 5) {
            saveHistory(history);
            dirty = 0;
          }
          await sleep(250);
        }
        if (history !== refreshingHistory) return;
        if (dirty) saveHistory(history);
        render();
      } catch (error) {
        if (history !== refreshingHistory) return;
        if (dirty) saveHistory(history);
        render(false);
        $("#dmh-summary").textContent = `Refresh stopped: ${error?.message || error}`;
      } finally {
        $("#dmh-refresh").disabled = false;
        refreshing = false;
      }
    }
    function goToPage() {
      const pages = Math.max(1, Math.ceil(filteredItems().length / PAGE_SIZE));
      let requested = parseInt($("#dmh-page-input").value, 10);
      if (!Number.isFinite(requested)) requested = page + 1;
      page = Math.max(1, Math.min(pages, requested)) - 1;
      render();
    }
    $("#dmh-delete-all").onclick = async () => {
      if (deleting) return;
      const targets = Object.values(history).filter((entry) => selected.has(selectionKey(entry)));
      if (!targets.length) return;
      deleting = true;
      render(false);
      try {
        const completed = await deleteConversations(targets);
        for (const entry of completed) {
          selected.delete(selectionKey(entry));
          entry.cleanupFinishedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
        if (completed.length) saveHistory(history);
      } finally {
        deleting = false;
        render(false);
      }
    };
    $("#dmh-search").oninput = (e) => {
      query = e.target.value || "";
      page = 0;
      render();
    };
    $("#dmh-refresh").onclick = refreshLive;
    $("#dmh-import").onclick = () => $("#dmh-folder").click();
    $("#dmh-folder").onchange = (e) => importPackage(e.target.files, { $, getHistory: () => history, getIdentity: async () => me || (me = await identity()), setPackageInfo: (value) => {
      packageInfo = value;
    }, persist, render });
    $("#dmh-prev").onclick = () => {
      page--;
      render();
    };
    $("#dmh-next").onclick = () => {
      page++;
      render();
    };
    $("#dmh-page-go").onclick = goToPage;
    $("#dmh-page-input").onkeydown = (e) => {
      if (e.key === "Enter") goToPage();
    };
    $("#dmh-clear").onclick = async () => {
      const approved = await askPopup({
        title: "Clear saved DM history?",
        message: "This clears the locally saved history, package cache, page, and search state. It does not delete or close Discord DMs.",
        yesText: "Clear",
        noText: "Cancel",
        danger: true
      });
      if (!approved) return;
      selected.clear();
      history = {};
      page = 0;
      query = "";
      packageInfo = null;
      $("#dmh-search").value = "";
      saveHistory(history);
      persist();
      render(false);
    };
    render(false);
    return { activate: () => render() };
  }

  // src/ui/log.js
  function createLog(logBox) {
    const logEntries = [];
    let scrollPending = false;
    const log = (type, message) => {
      const when = /* @__PURE__ */ new Date();
      const text = String(message);
      const div = document.createElement("div");
      div.className = `log-${type || "verb"}`;
      div.textContent = text;
      logBox.appendChild(div);
      if (logBox.childElementCount > LOG_DOM_LIMIT) {
        for (let i = 0; i < LOG_DOM_TRIM && logBox.firstChild; i++) {
          logBox.firstChild.remove();
        }
      }
      if (!scrollPending) {
        scrollPending = true;
        queueMicrotask(() => {
          scrollPending = false;
          logBox.scrollTop = logBox.scrollHeight;
        });
      }
      logEntries.push({ time: when.toISOString(), type: type || "verb", message: text });
      if (logEntries.length > LOG_ENTRY_LIMIT) logEntries.splice(0, LOG_DOM_TRIM);
    };
    return { log, logEntries };
  }

  // src/utils/messages.js
  function toSnowflake(value) {
    if (!value) return "";
    if (/^\d+$/.test(value)) return value;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) return "";
    return (BigInt(ms - 14200704e5) << 22n).toString();
  }
  function parseMessageReference(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    if (/^\d{15,22}$/.test(text)) return { messageId: text, guildId: "", channelId: "" };
    const match = text.match(/(?:https?:\/\/)?(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/([^/\s]+)\/(\d+)\/(\d+)/i);
    if (match) return { guildId: match[1], channelId: match[2], messageId: match[3] };
    return null;
  }
  function currentContext() {
    const m = location.pathname.match(/^\/channels\/([\w@]+)\/(\d+)/);
    return m ? { guildId: m[1], channelId: m[2] } : null;
  }
  function currentLabel() {
    const title = String(document.title || "").replace(/^Discord\s*[|—–-]\s*/i, "").replace(/\s*\|\s*Discord.*$/i, "").trim();
    const ctx = currentContext();
    if (!title || /^discord$/i.test(title)) {
      return ctx ? ctx.guildId === "@me" ? `DM ${ctx.channelId}` : `Channel ${ctx.channelId}` : "Unknown";
    }
    return title;
  }
  function qs(entries) {
    return entries.filter(([, v]) => v !== void 0 && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  }

  // src/discord/deleter-auth.js
  var authCache2 = null;
  async function validateToken(token, { log = () => {
  }, stopCheck = () => false, strict = false, signal } = {}) {
    if (!token) return null;
    try {
      const r = await apiFetch(`${API}/users/@me`, { headers: { Authorization: token }, signal }, log, stopCheck, { minIntervalMs: 1e3 });
      if (stopCheck()) throw new RunStoppedError();
      if (!r.ok) {
        if (strict && r.status !== 401) throw new Error(`Authorization check failed with HTTP ${r.status}. Export stopped.`);
        return null;
      }
      return await waitWithSignal(r.json(), signal);
    } catch (error) {
      if (strict || error instanceof RunStoppedError) throw error;
      return null;
    }
  }
  function invalidateAuth2() {
    authCache2 = null;
  }
  async function resolveToken(preferred = "", requestOptions = {}) {
    requestOptions.signal?.throwIfAborted();
    if (requestOptions.stopCheck?.()) throw new RunStoppedError();
    const now = Date.now();
    if (authCache2 && now - authCache2.at < AUTH_CACHE_TTL && (!preferred || preferred === authCache2.token)) {
      return authCache2.identity;
    }
    const candidates = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (token) => {
      if (token && !seen.has(token)) {
        seen.add(token);
        candidates.push(token);
      }
    };
    add(preferred);
    for (const token of tokenCandidates()) add(token);
    for (const token of candidates) {
      const user = await validateToken(token, requestOptions);
      if (user?.id) {
        const identity2 = { token, user };
        authCache2 = { at: now, token, identity: identity2 };
        return identity2;
      }
      if (requestOptions.strict) break;
    }
    invalidateAuth2();
    return null;
  }

  // src/features/queue.js
  function createQueue({ $, log, onChange = () => {
  } }) {
    const cache = createExpiringStorage(QUEUE_KEY);
    let queue = [];
    let idJobSequence = 0;
    try {
      queue = JSON.parse(cache.read() || "[]");
      if (!Array.isArray(queue)) queue = [];
    } catch {
      queue = [];
    }
    let storageWarning = false;
    const saveQueue = () => {
      try {
        if (!cache.write(JSON.stringify(queue))) throw new Error("Storage unavailable");
      } catch {
        if (!storageWarning) {
          storageWarning = true;
          log("warn", "Queue could not be saved locally. Keep this page open; refreshing may lose these jobs.");
        }
      }
      onChange();
    };
    const rows = /* @__PURE__ */ new Map();
    let emptyRow;
    let rendered = false;
    const setText = (node, text) => {
      if (node.textContent !== text) node.textContent = text;
    };
    const createRow = (item) => {
      const row = document.createElement("div");
      row.className = "dmd-queue-row";
      const num = document.createElement("span");
      num.className = "dmd-queue-index";
      const avatar = document.createElement("span");
      avatar.className = "dmd-queue-avatar";
      const letter = document.createTextNode("");
      avatar.appendChild(letter);
      const info = document.createElement("div");
      info.className = "dmd-queue-info";
      const title = document.createElement("div");
      title.className = "dmd-queue-title";
      const ids = document.createElement("div");
      ids.className = "dmd-queue-ids";
      info.append(title, ids);
      const up = document.createElement("button");
      up.className = "dmd-btn";
      up.textContent = "\u2191";
      const down = document.createElement("button");
      down.className = "dmd-btn";
      down.textContent = "\u2193";
      const remove = document.createElement("button");
      remove.className = "dmd-btn dmd-red";
      remove.textContent = "Remove";
      up.onclick = () => {
        const index = queue.indexOf(item);
        if (index <= 0) return;
        [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
        saveQueue();
        renderQueue();
      };
      down.onclick = () => {
        const index = queue.indexOf(item);
        if (index < 0 || index >= queue.length - 1) return;
        [queue[index], queue[index + 1]] = [queue[index + 1], queue[index]];
        saveQueue();
        renderQueue();
      };
      remove.onclick = () => {
        const index = queue.indexOf(item);
        if (index < 0) return;
        queue.splice(index, 1);
        saveQueue();
        renderQueue();
      };
      row.append(num, avatar, info, up, down, remove);
      return { row, num, avatar, letter, title, ids, up, down, icon: "", image: null };
    };
    const renderQueue = () => {
      const box = $("#dmd-multi-list");
      if (!rendered) {
        box.textContent = "";
        rendered = true;
      }
      setText($("#dmd-multi-count"), `${queue.length} queued`);
      const currentItems = new Set(queue);
      for (const [item, record] of rows) {
        if (!currentItems.has(item)) {
          record.row.remove();
          rows.delete(item);
        }
      }
      if (!queue.length) {
        if (!emptyRow) {
          emptyRow = document.createElement("div");
          emptyRow.className = "dmd-muted";
          emptyRow.style.padding = "14px";
          emptyRow.textContent = "Queue is empty.";
        }
        if (emptyRow.parentNode !== box) box.appendChild(emptyRow);
        return;
      }
      emptyRow?.remove();
      const fragment = document.createDocumentFragment();
      let nextRow = box.firstElementChild;
      queue.forEach((item, index) => {
        let record = rows.get(item);
        if (!record) {
          record = createRow(item);
          rows.set(item, record);
        }
        const label = cleanQueueLabel(item.label);
        setText(record.num, `${index + 1}.`);
        setText(record.letter, (item.iconName || label || "?").slice(0, 1).toUpperCase());
        setText(record.title, label || item.channelId);
        setText(record.ids, item.kind === "ids" ? `${item.targets.length} individual messages` : item.kind === "server" ? `Server ${item.guildId}` : `${item.guildId} / ${item.channelId}`);
        if (record.up.disabled !== (index === 0)) record.up.disabled = index === 0;
        if (record.down.disabled !== (index === queue.length - 1)) record.down.disabled = index === queue.length - 1;
        const icon = /^https:\/\/cdn\.discordapp\.com\/(?:avatars|icons|embed\/avatars)\//.test(item.icon || "") ? item.icon : "";
        if (record.icon !== icon) {
          record.image?.remove();
          record.image = null;
          record.icon = icon;
          if (icon) {
            const image = document.createElement("img");
            image.src = icon;
            image.onerror = () => image.remove();
            record.avatar.appendChild(image);
            record.image = image;
          }
        }
        if (record.image && record.image.alt !== (item.iconName || label || "Queue icon")) record.image.alt = item.iconName || label || "Queue icon";
        if (nextRow === record.row) nextRow = nextRow.nextElementSibling;
        else if (nextRow) box.insertBefore(record.row, nextRow);
        else fragment.appendChild(record.row);
      });
      if (fragment.childNodes.length) box.appendChild(fragment);
    };
    const addQueueItems = (items) => {
      const keys = new Set(queue.map((item) => `${item.guildId}/${item.channelId}`));
      let added = 0;
      for (const item of items) {
        const guildId = String(item.guildId || "").trim(), channelId = String(item.channelId || "").trim();
        if (!guildId || !channelId) {
          log("error", "Server/DM ID and Channel ID are required.");
          continue;
        }
        const key = `${guildId}/${channelId}`;
        if (keys.has(key)) {
          log("warn", "That DM/channel is already queued.");
          continue;
        }
        keys.add(key);
        queue.push({ ...item, guildId, channelId, thread: item.thread === true, label: item.label || (guildId === "@me" ? `DM ${channelId}` : `Channel ${channelId}`) });
        added++;
      }
      if (added) {
        saveQueue();
        renderQueue();
      }
      return added;
    };
    const addQueueItem = (guildId, channelId, label = "", thread = false, settings = {}) => addQueueItems([{ ...settings, guildId, channelId, label, thread }]);
    const addIdJob = (targets, options) => {
      if (!targets.length) return log("warn", "Enter at least one message ID.");
      const pairs = (values) => values.map((target) => `${target.channelId}/${target.messageId}`).sort();
      const keys = pairs(targets);
      if (queue.some((item) => item.guildId === "@ids" && Array.isArray(item.targets) && item.targets.length === targets.length && pairs(item.targets).every((key, index) => key === keys[index]))) {
        return log("warn", "That message ID batch is already queued.");
      }
      let channelId;
      do {
        channelId = `ids:${Date.now().toString(36)}:${(idJobSequence++).toString(36)}`;
      } while (queue.some((item) => item.guildId === "@ids" && item.channelId === channelId));
      addQueueItem("@ids", channelId, `${targets.length} message IDs`, false, { kind: "ids", targets, options });
    };
    const completeItem = (item) => {
      const index = queue.findIndex((entry) => entry.guildId === item.guildId && entry.channelId === item.channelId);
      if (index < 0) return;
      queue.splice(index, 1);
      saveQueue();
      renderQueue();
    };
    const updateIdentity = (item, identity2) => {
      const entry = queue.find((value) => value.guildId === item.guildId && value.channelId === item.channelId);
      if (!entry) return;
      Object.assign(entry, { label: identity2.label, icon: identity2.icon, iconName: identity2.iconName });
      saveQueue();
      renderQueue();
    };
    renderQueue();
    return { renderQueue, addQueueItem, addQueueItems, addIdJob, completeItem, updateIdentity, getItems: () => queue, clear: () => {
      queue = [];
      saveQueue();
      renderQueue();
    } };
  }

  // src/utils/drag.js
  function installPanelWindowControls({ panel, dragHandle = panel, resizeHandle, resizeHandles = resizeHandle ? [resizeHandle] : [], storage, storageKey, minWidth = 560, defaultWidth = 940, defaultRatio = 1.35 }) {
    const MIN_WIDTH = minWidth;
    const EDGE = 8;
    let ratio = null;
    let geometryReady = false;
    const frameUpdates = (apply) => {
      let queued = false, frame = null, point = null;
      const flush = () => {
        queued = false;
        frame = null;
        if (!point) return;
        const latest = point;
        point = null;
        apply(latest);
      };
      const move = (event) => {
        point = { clientX: event.clientX, clientY: event.clientY };
        if (typeof window.requestAnimationFrame !== "function") {
          flush();
          return;
        }
        if (!queued) {
          queued = true;
          frame = window.requestAnimationFrame(flush);
        }
      };
      const finish = () => {
        if (frame !== null) window.cancelAnimationFrame?.(frame);
        flush();
      };
      return { move, finish };
    };
    const readSaved = () => {
      try {
        const saved = JSON.parse(storage().getItem(storageKey) || "null");
        if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top) || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;
        return saved;
      } catch {
        return null;
      }
    };
    const saveGeometry = () => {
      if (!geometryReady) return;
      const r = panel.getBoundingClientRect();
      try {
        storage().setItem(storageKey, JSON.stringify({
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          ratio: ratio || r.width / r.height
        }));
      } catch {
      }
    };
    const fitSize = (wantedWidth, wantedRatio) => {
      const maxW = Math.max(260, window.innerWidth - EDGE * 2);
      const maxH = Math.max(220, window.innerHeight - EDGE * 2);
      const minW = Math.min(MIN_WIDTH, maxW);
      let w = Math.max(minW, Math.min(maxW, wantedWidth));
      let h = w / wantedRatio;
      if (h > maxH) {
        h = maxH;
        w = h * wantedRatio;
      }
      if (w > maxW) {
        w = maxW;
        h = w / wantedRatio;
      }
      return { width: w, height: h };
    };
    const clampPosition = () => {
      if (!geometryReady) return;
      const r = panel.getBoundingClientRect();
      const maxLeft = Math.max(EDGE, window.innerWidth - r.width - EDGE);
      const maxTop = Math.max(EDGE, window.innerHeight - r.height - EDGE);
      const left = Math.min(maxLeft, Math.max(EDGE, r.left));
      const top = Math.min(maxTop, Math.max(EDGE, r.top));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const ensureGeometry = () => {
      if (geometryReady) return;
      const saved = readSaved();
      const current = panel.getBoundingClientRect();
      ratio = saved?.ratio && Number.isFinite(saved.ratio) && saved.ratio > 0 ? saved.ratio : current.width > 0 && current.height > 0 ? current.width / current.height : defaultRatio;
      const desiredWidth = saved?.width || current.width || Math.min(defaultWidth, window.innerWidth - 36);
      const size = fitSize(desiredWidth, ratio);
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.width = `${size.width}px`;
      panel.style.height = `${size.height}px`;
      panel.style.left = `${saved?.left ?? Math.max(EDGE, window.innerWidth - size.width - 18)}px`;
      panel.style.top = `${saved?.top ?? 62}px`;
      geometryReady = true;
      clampPosition();
    };
    dragHandle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.isPrimary === false) return;
      if (e.target.closest('button,input,textarea,select,option,label,summary,a,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="dialog"],[role="listbox"],[data-resize-corner],#dmd-log')) return;
      ensureGeometry();
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = r.left, startTop = r.top;
      const { move, finish } = frameUpdates((ev) => {
        const maxLeft = Math.max(EDGE, window.innerWidth - r.width - EDGE);
        const maxTop = Math.max(EDGE, window.innerHeight - r.height - EDGE);
        panel.style.left = `${Math.min(maxLeft, Math.max(EDGE, startLeft + ev.clientX - startX))}px`;
        panel.style.top = `${Math.min(maxTop, Math.max(EDGE, startTop + ev.clientY - startY))}px`;
      });
      const up = () => {
        finish();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        saveGeometry();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
    });
    for (const handle of resizeHandles) handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      ensureGeometry();
      e.preventDefault();
      e.stopPropagation();
      const r = panel.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const fromLeft = handle.dataset.resizeCorner === "left";
      const startW = r.width, startH = r.height;
      const { move, finish } = frameUpdates((ev) => {
        const maxWidth = fromLeft ? r.left + startW - EDGE : window.innerWidth - r.left - EDGE;
        const maxHeight = window.innerHeight - r.top - EDGE;
        const width = Math.max(Math.min(MIN_WIDTH, maxWidth), Math.min(maxWidth, startW + (ev.clientX - startX) * (fromLeft ? -1 : 1)));
        const height = Math.max(Math.min(300, maxHeight), Math.min(maxHeight, startH + ev.clientY - startY));
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
        ratio = width / height;
        if (fromLeft) panel.style.left = `${r.left + startW - width}px`;
      });
      const up = () => {
        finish();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        saveGeometry();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
    });
    window.addEventListener("resize", () => {
      if (!geometryReady || panel.style.display !== "flex") return;
      const r = panel.getBoundingClientRect();
      const currentRatio = ratio || r.width / r.height;
      const size = fitSize(r.width, currentRatio);
      panel.style.width = `${size.width}px`;
      panel.style.height = `${size.height}px`;
      clampPosition();
      saveGeometry();
    });
    return { ensureGeometry };
  }

  // src/discord/toolbar.js
  function findDiscordToolbar() {
    let best = null, bestScore = -Infinity;
    for (const el of document.querySelectorAll('[role="toolbar"], [class*="toolbar"]')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 80 || r.height <= 20 || r.top < 0 || r.top >= 140 || el.offsetParent === null) continue;
      let score = 0;
      if (r.top < 80) score += 20;
      if (r.right > innerWidth * 0.55) score += 20;
      score += Math.min(10, el.querySelectorAll('button,[role="button"]').length);
      if (el.closest("header")) score += 15;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  // src/discord/page-observer.js
  var listeners = /* @__PURE__ */ new Set();
  var observer;
  var scheduled = false;
  var generation = 0;
  function observeDiscordPage(listener) {
    listeners.add(listener);
    if (!observer) {
      const version = ++generation;
      observer = new MutationObserver((records) => {
        if (records?.length && records.every((record) => {
          if (record.target?.closest?.("#dmd-panel, #dmh-panel, #dmd-toolbar-btn, .dmd-select-menu, .dmd-calendar")) return true;
          const changedNodes = [...record.addedNodes || [], ...record.removedNodes || []];
          return changedNodes.length > 0 && changedNodes.every((node) => node.matches?.(".dmd-select-menu, .dmd-calendar"));
        })) return;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          if (version !== generation) return;
          scheduled = false;
          for (const callback of listeners) callback();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size && observer) {
        observer.disconnect();
        observer = null;
        generation++;
        scheduled = false;
      }
    };
  }

  // src/utils/files.js
  function safeFilePart(value) {
    return String(value || "discord").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "discord";
  }
  function timeStampForFile() {
    const d = /* @__PURE__ */ new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function downloadTextFile(filename, text, type = "text/plain;charset=utf-8") {
    downloadBlob(filename, new Blob([text], { type }));
  }
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // src/features/asset-filters.js
  function compilePattern(source, flags = "i", label = "Regular expression") {
    source = String(source || "").trim();
    if (!source) return null;
    if (source.length > 1e3) throw new Error(`${label} is too long (maximum 1,000 characters).`);
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error(`${label}: use only i, m, s, and u flags, without duplicates.`);
    try {
      return new RegExp(source, flags);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`, { cause: error });
    }
  }
  function messageUrls(message) {
    const urls = /* @__PURE__ */ new Set();
    const text = String(message.content || "");
    for (const match of text.matchAll(/https?:\/\/[^\s<>`"']+/gi)) {
      let url = match[0].replace(/[.,!;:]+$/, "");
      for (const marker of ["**", "__", "~~", "||", "*", "_"]) {
        if (text.slice(0, match.index).endsWith(marker) && url.endsWith(marker)) url = url.slice(0, -marker.length);
      }
      while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
      if (url) urls.add(url);
    }
    for (const embed of message.embeds || []) {
      const url = embed.url || embed.image?.url;
      if (/^https?:\/\//i.test(url || "")) urls.add(url);
    }
    return [...urls];
  }
  function assetsFor(message) {
    const assets = (message.attachments || []).map((file) => ({ name: String(file.filename || ""), url: String(file.url || "") }));
    for (const url of messageUrls(message)) {
      try {
        const path = new URL(url).pathname;
        let name = path.split("/").at(-1) || "";
        try {
          name = decodeURIComponent(name);
        } catch {
        }
        assets.push({ name, url });
      } catch {
      }
    }
    return assets;
  }
  function matchesAssets(message, options) {
    if (!options.filename && !options.extensions.length && !options.assetPattern) return true;
    const matches = assetsFor(message).some((asset) => {
      if (options.filename && !asset.name.toLowerCase().includes(options.filename.toLowerCase())) return false;
      const extension = asset.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || "";
      if (options.extensions.length && !options.extensions.includes(extension)) return false;
      if (options.assetPattern && !options.assetPattern.test(`${asset.name}
${asset.url}`)) return false;
      return true;
    });
    return options.assetMode === "exclude" ? !matches : matches;
  }

  // src/features/message-filters.js
  function normalizeCleanupOptions(options) {
    const action = options.action || "delete";
    if (!["delete", "overwrite", "preserve"].includes(action)) throw new Error("Choose a valid message action.");
    const overwriteText = String(options.overwriteText ?? "");
    if (action === "overwrite" && (!overwriteText.trim() || overwriteText.length > 2e3)) {
      throw new Error("Replacement text must contain between 1 and 2,000 characters.");
    }
    const normalizeMode = (mode, fallback) => {
      const value = mode || fallback;
      if (!["any", "with", "without"].includes(value)) throw new Error("Invalid message filter.");
      return value;
    };
    const boundary = (value) => {
      const id = toSnowflake(value);
      if (value && (!id || !/^\d+$/.test(id))) throw new Error("Invalid message/date boundary.");
      return id;
    };
    const minId = boundary(options.minId);
    const maxId = boundary(options.maxId);
    if (minId && maxId && BigInt(minId) >= BigInt(maxId)) throw new Error("After must be earlier than Before.");
    const order = options.order || "desc";
    if (!["asc", "desc"].includes(order)) throw new Error("Invalid message order.");
    const textMode = options.textMode || "include";
    if (!["include", "exclude"].includes(textMode)) throw new Error("Invalid text filter.");
    const regexMode = options.regexMode || "include";
    const assetMode = options.assetMode || "include";
    if (![regexMode, assetMode].every((mode) => ["include", "exclude"].includes(mode))) throw new Error("Invalid pattern filter.");
    const extensions = (Array.isArray(options.extensions) ? options.extensions : String(options.extensions || "").split(/[\s,;]+/)).map((extension) => String(extension).trim().replace(/^\*?\./, "").toLowerCase()).filter(Boolean);
    if (extensions.some((extension) => !/^[a-z0-9_-]+$/.test(extension))) throw new Error("Use extensions such as png, jpg, or zip, separated by commas.");
    const textPattern = compilePattern(options.textRegex, options.regexFlags ?? "i", "Text regex");
    const assetPattern = compilePattern(options.assetRegex, options.assetRegexFlags ?? "i", "File/URL regex");
    return {
      ...options,
      action,
      overwriteText,
      order,
      textMode,
      minId,
      maxId,
      regexMode,
      assetMode,
      textPattern,
      assetPattern,
      extensions: [...new Set(extensions)],
      filename: String(options.filename || "").trim(),
      collectAll: options.collectAll === true,
      content: String(options.content || "").trim(),
      linkMode: normalizeMode(options.linkMode, options.hasLink ? "with" : "any"),
      fileMode: normalizeMode(options.fileMode, options.hasFile ? "with" : "any"),
      pinnedMode: normalizeMode(options.pinnedMode, options.includePinned ? "any" : "without")
    };
  }
  function matchesMessage(message, options) {
    if (!options.authorId || message.author?.id !== options.authorId) return false;
    if (options.authorIds?.length && !options.authorIds.includes(message.author?.id)) return false;
    if (options.channelId && message.channel_id !== options.channelId) return false;
    if (![0, 6, 19].includes(message.type)) return false;
    if (!/^\d+$/.test(String(message.id || ""))) return false;
    if (options.minId && compareMessageIds(message.id, options.minId) <= 0) return false;
    if (options.maxId && compareMessageIds(message.id, options.maxId) >= 0) return false;
    const matchMode = (mode, value) => mode === "any" || (mode === "with" ? value : !value);
    if (options.linkMode !== "any") {
      const hasLink = /https?:\/\/\S+/i.test(message.content || "") || (message.embeds || []).some((embed) => !!embed.url);
      if (!matchMode(options.linkMode, hasLink)) return false;
    }
    if (!matchMode(options.fileMode, !!message.attachments?.length)) return false;
    if (!matchMode(options.pinnedMode, !!message.pinned)) return false;
    if (options.content) {
      const contains = String(message.content || "").toLowerCase().includes(options.content.toLowerCase());
      if (options.textMode === "exclude" ? contains : !contains) return false;
    }
    if (options.textPattern) {
      const matches = options.textPattern.test(String(message.content || ""));
      if (options.regexMode === "exclude" ? matches : !matches) return false;
    }
    if (!matchesAssets(message, options)) return false;
    return true;
  }
  function compareMessageIds(leftId, rightId) {
    const left = String(leftId), right = String(rightId);
    if (left === right) return 0;
    if (left[0] === "0" || right[0] === "0") {
      const a = BigInt(left), b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return left.length === right.length ? left < right ? -1 : 1 : left.length < right.length ? -1 : 1;
  }
  function sortMessages(messages, order) {
    const direction = order === "asc" ? 1 : -1;
    return [...messages].sort((a, b) => direction * compareMessageIds(a.id, b.id));
  }

  // src/features/export.js
  function compactReferencedMessage(message) {
    if (!message) return null;
    return {
      id: message.id || null,
      timestamp: message.timestamp || null,
      content: message.content || "",
      author: message.author ? {
        id: message.author.id || null,
        username: message.author.username || "",
        globalName: message.author.global_name || null,
        bot: !!message.author.bot
      } : null
    };
  }
  function compactExportMessage(message) {
    return {
      // Keep the original response, including fields added by Discord in future.
      raw: message,
      id: message.id,
      timestamp: message.timestamp,
      editedTimestamp: message.edited_timestamp || null,
      type: message.type,
      pinned: !!message.pinned,
      content: message.content || "",
      author: message.author ? {
        id: message.author.id || null,
        username: message.author.username || "",
        globalName: message.author.global_name || null,
        discriminator: message.author.discriminator || null,
        bot: !!message.author.bot
      } : null,
      attachments: (message.attachments || []).map((a) => ({
        id: a.id,
        filename: a.filename,
        description: a.description || null,
        contentType: a.content_type || null,
        size: a.size || 0,
        url: a.url,
        proxyUrl: a.proxy_url || null,
        width: a.width || null,
        height: a.height || null
      })),
      embeds: message.embeds || [],
      reactions: (message.reactions || []).map((r) => ({
        count: r.count,
        emoji: r.emoji,
        me: !!r.me
      })),
      mentions: (message.mentions || []).map((u) => ({
        id: u.id,
        username: u.username || "",
        globalName: u.global_name || null
      })),
      referencedMessage: compactReferencedMessage(message.referenced_message)
    };
  }
  function validateExportRange({ minId = "", maxId = "" } = {}) {
    minId = String(minId).trim();
    maxId = String(maxId).trim();
    const boundary = (value) => {
      const id = toSnowflake(value);
      if (value && (!id || !/^\d+$/.test(id))) throw new Error("Enter a valid date/time or message ID.");
      return id;
    };
    const after = boundary(minId), before = boundary(maxId);
    if (after && before && BigInt(after) >= BigInt(before)) throw new Error("After must be earlier than Before.");
    return { minId, maxId };
  }
  async function exportConversationData({ token, guildId, channelId, minId, maxId, label, log, stopCheck = () => false, signal }) {
    ({ minId, maxId } = validateExportRange({ minId, maxId }));
    const afterSnowflake = minId ? toSnowflake(minId) : "";
    let beforeSnowflake = maxId ? toSnowflake(maxId) : "";
    let afterBig = null;
    try {
      if (afterSnowflake) afterBig = BigInt(afterSnowflake);
    } catch {
    }
    const messages = [];
    let page = 0;
    log("info", `Exporting conversation ${label || channelId}...`);
    while (!stopCheck()) {
      const url = `${API}/channels/${channelId}/messages?limit=100${beforeSnowflake ? `&before=${beforeSnowflake}` : ""}`;
      let response;
      try {
        response = await apiFetch(url, { headers: { Authorization: token }, signal }, log, stopCheck, { minIntervalMs: 1e3 });
      } catch (error) {
        if (error instanceof RunStoppedError) break;
        throw error;
      }
      if (stopCheck()) break;
      if (response.status === 401) {
        invalidateAuth2();
        throw new Error("Discord rejected the authorization token while exporting.");
      }
      if (response.status === 403) throw new Error("Discord denied access to this conversation.");
      if (!response.ok) throw new Error(`Conversation export failed with HTTP ${response.status}.`);
      const batch = await waitWithSignal(response.json(), signal);
      if (stopCheck()) break;
      if (!Array.isArray(batch)) throw new Error("Discord returned an invalid message page. Export stopped.");
      if (!batch.length) break;
      page++;
      const beforeBig = beforeSnowflake ? BigInt(beforeSnowflake) : null;
      const seen = /* @__PURE__ */ new Set();
      let oldest = null;
      let reachedAfter = false;
      for (const message of batch) {
        if (typeof message?.id !== "string" || !/^\d+$/.test(message.id)) throw new Error("Discord returned a malformed message. Export stopped.");
        let idBig = null;
        try {
          idBig = BigInt(message.id);
        } catch {
        }
        if (idBig === null) continue;
        if (beforeBig !== null && idBig >= beforeBig) continue;
        if (afterBig !== null && idBig <= afterBig) {
          reachedAfter = true;
          continue;
        }
        if (!seen.has(message.id)) {
          seen.add(message.id);
          messages.push(compactExportMessage(message));
        }
        if (oldest === null || idBig < oldest) oldest = idBig;
      }
      log("verb", `Export page ${page}: ${messages.length} messages collected.`);
      if (reachedAfter) break;
      if (oldest === null) throw new Error("Message pagination did not advance. Export stopped to avoid saving incomplete history.");
      beforeSnowflake = oldest.toString();
    }
    messages.sort((a, b) => compareMessageIds(a.id, b.id));
    return {
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      guildId,
      channelId,
      label: label || "",
      range: {
        after: minId || null,
        before: maxId || null
      },
      messageCount: messages.length,
      messages
    };
  }
  var csvColumns = ["guildId", "channelId", "conversation", "id", "timestamp", "editedTimestamp", "authorId", "username", "content", "type", "pinned", "attachments", "embeds", "reactions", "mentions", "referencedMessage", "messageData"];
  var nestedColumns = ["attachments", "embeds", "reactions", "mentions", "referencedMessage"];
  var csvCell = (value) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
  function* conversationCsvRows(conversations, includeHeader = true) {
    if (includeHeader) yield csvColumns.map(csvCell).join(",");
    for (const conversation of conversations) {
      for (const message of conversation.messages) {
        yield [
          conversation.guildId,
          conversation.channelId,
          conversation.label,
          message.id,
          message.timestamp,
          message.editedTimestamp,
          message.author?.id,
          message.author?.username,
          message.content,
          message.type,
          message.pinned,
          ...nestedColumns.map((key) => JSON.stringify(message[key] ?? null)),
          JSON.stringify(message.raw ?? message)
        ].map(csvCell).join(",");
      }
    }
  }
  function* conversationJsonParts(conversation) {
    const { messages, ...metadata } = conversation;
    const wrapper = JSON.stringify({ ...metadata, messages: [] }, null, 2);
    yield wrapper.slice(0, -4) + "[\n";
    for (let index = 0; index < messages.length; index++) {
      yield (index ? ",\n" : "") + "    " + JSON.stringify(messages[index]);
    }
    yield "\n  ]\n}";
  }
  function* conversationCsvParts(conversation, includeHeader) {
    let first = true;
    for (const row of conversationCsvRows([conversation], includeHeader)) {
      yield (first ? "" : "\r\n") + row;
      first = false;
    }
  }
  async function conversationToBlob(conversation, { format = "json", includeCsvHeader = true, stopCheck = () => false } = {}) {
    const parts = format === "csv" ? conversationCsvParts(conversation, includeCsvHeader) : conversationJsonParts(conversation);
    const blobs = [];
    let chunks = [], size = 0, yieldedAt = performance.now();
    const checkStopped = () => {
      if (stopCheck()) throw new RunStoppedError();
    };
    const flush = () => {
      blobs.push(new Blob([chunks.join("")]));
      chunks = [];
      size = 0;
    };
    checkStopped();
    for (const part of parts) {
      chunks.push(part);
      size += part.length;
      if (size < 65536) continue;
      checkStopped();
      flush();
      if (performance.now() - yieldedAt >= 8) {
        await sleep(0);
        checkStopped();
        yieldedAt = performance.now();
      }
    }
    checkStopped();
    if (chunks.length) flush();
    return new Blob(blobs, { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
  }

  // src/ui/export-selection.js
  function askExportSelection(conversations, { range = {}, select = true, signal } = {}) {
    const selected = new Set(select ? [] : conversations.map((_, index) => index));
    let exportRange = { minId: range.minId || "", maxId: range.maxId || "" };
    let format = "json", downloadAttachments = false;
    return askPopup({
      signal,
      title: "Export Conversations",
      message: "Choose conversations, a date or message range, and a file format. Blank boundaries export all readable history. All message data returned by Discord is included; enable attachment downloads to include the actual files in a ZIP (up to 4 GB).",
      yesText: "Export",
      noText: "Cancel",
      getResult: () => ({ conversations: conversations.filter((_, index) => selected.has(index)), format, range: exportRange, downloadAttachments }),
      render: ({ box, yes }) => {
        const boundaries = [];
        const error = document.createElement("div");
        error.setAttribute("role", "alert");
        const validate = () => {
          try {
            for (const { input, kind } of boundaries) {
              if (input.validity.badInput) throw new Error("Complete the date and time or clear the boundary.");
              if (kind.value === "id" && input.value && !/^\d+$/.test(input.value.trim())) throw new Error("Enter a numeric message ID.");
            }
            exportRange = validateExportRange(exportRange);
            error.textContent = "";
          } catch (issue) {
            error.textContent = issue.message;
          }
          yes.disabled = !selected.size || !!error.textContent;
        };
        validate();
        const all = document.createElement("button");
        all.type = "button";
        all.className = "dmd-btn";
        all.textContent = "Select all";
        all.disabled = !conversations.length;
        const list = document.createElement("div");
        list.className = "dmd-export-list";
        list.onchange = (event) => {
          const input = event.target, index = Number(input.value);
          if (input.checked) selected.add(index);
          else selected.delete(index);
          validate();
        };
        conversations.forEach((item, index) => {
          const label = document.createElement("label");
          label.className = "dmd-check";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = String(index);
          input.checked = selected.has(index);
          label.append(input, document.createTextNode(item.label || item.channelId));
          list.append(label);
        });
        all.onclick = () => {
          list.querySelectorAll("input").forEach((input) => {
            input.checked = true;
            selected.add(Number(input.value));
          });
          validate();
        };
        const formats = document.createElement("fieldset");
        formats.className = "dmd-export-formats";
        const legend = document.createElement("legend");
        legend.textContent = "File format";
        formats.append(legend);
        for (const value of ["json", "csv"]) {
          const label = document.createElement("label");
          label.className = "dmd-check";
          const input = document.createElement("input");
          input.type = "radio";
          input.name = "dmd-export-format";
          input.value = value;
          input.checked = value === format;
          input.onchange = () => {
            if (input.checked) format = value;
          };
          label.append(input, document.createTextNode(value.toUpperCase()));
          formats.append(label);
        }
        const ranges = document.createElement("fieldset");
        ranges.className = "dmd-export-range";
        const rangeLegend = document.createElement("legend");
        rangeLegend.textContent = "Date & message range (local time)";
        ranges.append(rangeLegend);
        for (const [key, name] of [["minId", "After"], ["maxId", "Before"]]) {
          const field = document.createElement("div");
          field.className = "dmd-field";
          const label = document.createElement("label");
          label.htmlFor = `dmd-export-${key}`;
          label.textContent = name;
          const kind = document.createElement("select");
          kind.setAttribute("aria-label", `${name} boundary type`);
          for (const [value, text] of [["date", "Date & time"], ["id", "Message ID"]]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            kind.append(option);
          }
          kind.value = /^\d+$/.test(exportRange[key]) ? "id" : "date";
          const input = document.createElement("input");
          input.id = label.htmlFor;
          input.type = kind.value === "date" ? "datetime-local" : "text";
          input.step = "any";
          input.value = exportRange[key];
          boundaries.push({ input, kind });
          input.oninput = input.onchange = () => {
            exportRange[key] = input.value;
            validate();
          };
          kind.onchange = () => {
            input.type = kind.value === "date" ? "datetime-local" : "text";
            input.value = "";
            exportRange[key] = "";
            validate();
          };
          field.append(label, kind, input);
          ranges.append(field);
        }
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "dmd-btn";
        clear.textContent = "All dates";
        clear.onclick = () => {
          ranges.querySelectorAll("input").forEach((input) => {
            input.value = "";
          });
          exportRange = { minId: "", maxId: "" };
          validate();
        };
        ranges.append(clear, error);
        const attachmentLabel = document.createElement("label");
        attachmentLabel.className = "dmd-check";
        const attachmentToggle = document.createElement("input");
        attachmentToggle.type = "checkbox";
        attachmentToggle.id = "dmd-export-attachments";
        attachmentToggle.onchange = () => {
          downloadAttachments = attachmentToggle.checked;
        };
        attachmentLabel.append(attachmentToggle, document.createTextNode("Download actual attachments (ZIP)"));
        box.append(all, list, ranges, formats, attachmentLabel);
      }
    });
  }

  // src/utils/run-state.js
  var runState = { stopped: false, reactionStopped: false, multiStopped: false };

  // src/utils/zip.js
  var crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    for (let bit = 0; bit < 8; bit++) index = index >>> 1 ^ (index & 1 ? 3988292384 : 0);
    return index;
  });
  var ZipCapacityError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ZipCapacityError";
    }
  };
  var checkCapacity = (count, size) => {
    if (count >= 65535) throw new ZipCapacityError("Too many files for one ZIP. Export fewer conversations or a smaller date range.");
    if (size >= 4294967295) throw new ZipCapacityError("ZIP exceeds 4 GB. Export fewer conversations or a smaller date range.");
  };
  var zipPath = (name, size) => {
    if (!name || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid ZIP file path.");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid ZIP file size.");
    const path = new TextEncoder().encode(name);
    if (path.length > 65535 || size >= 4294967295) throw new ZipCapacityError("ZIP exceeds 4 GB. Export fewer conversations or a smaller date range.");
    return path;
  };
  function createZipBudget() {
    const entries = /* @__PURE__ */ new Map();
    let size = 22;
    const checkFile = (name, bytes) => {
      const previous = entries.get(name);
      const entrySize = 76 + 2 * zipPath(name, bytes).length + bytes;
      const nextSize = size - (previous ?? 0) + entrySize;
      checkCapacity(entries.size + (previous === void 0 ? 1 : 0), nextSize);
      return { entrySize, nextSize };
    };
    return {
      checkFile(name, bytes) {
        checkFile(name, bytes);
      },
      setFile(name, bytes) {
        const { entrySize, nextSize } = checkFile(name, bytes);
        entries.set(name, entrySize);
        size = nextSize;
      }
    };
  }
  async function filesToZip(files, stopCheck = () => false) {
    const check = () => {
      if (stopCheck()) throw new RunStoppedError();
    };
    check();
    checkCapacity(files.length, 22);
    const paths = [];
    let archiveSize = 22, yieldedAt = performance.now();
    for (const { name, blob } of files) {
      check();
      const path = zipPath(name, blob.size);
      paths.push(path);
      archiveSize += 76 + 2 * path.length + blob.size;
      checkCapacity(files.length, archiveSize);
      if (performance.now() - yieldedAt >= 8) {
        await sleep(0);
        check();
        yieldedAt = performance.now();
      }
    }
    const parts = [], central = [];
    let offset = 0, centralSize = 0;
    for (const [index, { blob }] of files.entries()) {
      check();
      const path = paths[index];
      let crc = 4294967295;
      for (let start = 0; start < blob.size; start += 65536) {
        check();
        const bytes = new Uint8Array(await blob.slice(start, start + 65536).arrayBuffer());
        for (let index2 = 0; index2 < bytes.length; index2++) crc = crc >>> 8 ^ crcTable[(crc ^ bytes[index2]) & 255];
        if (performance.now() - yieldedAt >= 8) {
          await sleep(0);
          check();
          yieldedAt = performance.now();
        }
      }
      check();
      crc = (crc ^ 4294967295) >>> 0;
      const local = new Uint8Array(30), localView = new DataView(local.buffer);
      localView.setUint32(0, 67324752, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 2048, true);
      localView.setUint16(12, 33, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, blob.size, true);
      localView.setUint32(22, blob.size, true);
      localView.setUint16(26, path.length, true);
      const entry = new Uint8Array(46), view2 = new DataView(entry.buffer);
      view2.setUint32(0, 33639248, true);
      view2.setUint16(4, 20, true);
      view2.setUint16(6, 20, true);
      view2.setUint16(8, 2048, true);
      view2.setUint16(14, 33, true);
      view2.setUint32(16, crc, true);
      view2.setUint32(20, blob.size, true);
      view2.setUint32(24, blob.size, true);
      view2.setUint16(28, path.length, true);
      view2.setUint32(42, offset, true);
      parts.push(local, path, blob);
      central.push(entry, path);
      offset += local.length + path.length + blob.size;
      centralSize += entry.length + path.length;
      if (performance.now() - yieldedAt >= 8) {
        await sleep(0);
        check();
        yieldedAt = performance.now();
      }
    }
    check();
    checkCapacity(files.length, offset + centralSize + 22);
    const end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 101010256, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  // src/features/export-attachments.js
  var createAttachmentDownloadState = () => ({ cache: /* @__PURE__ */ new Map(), failedUrls: /* @__PURE__ */ new Map(), consecutiveFailures: 0, suspendedReason: "" });
  function* snapshotAttachmentSources(message, prefix = "", sourcePrefix = "") {
    for (const [index, snapshot] of (message.message_snapshots || []).entries()) {
      yield { attachments: snapshot.message?.attachments || [], prefix: `${prefix}snapshots/${index + 1}/`, source: `${sourcePrefix}message_snapshots[${index}].message.attachments` };
    }
  }
  function* messageAttachmentEntries(message) {
    const raw = message.raw || message;
    const sources = [{ attachments: raw.attachments || message.attachments || [], prefix: "", source: "attachments" }, ...snapshotAttachmentSources(raw)];
    if (raw.type === 21 && raw.referenced_message) {
      sources.push({ attachments: raw.referenced_message.attachments || [], prefix: "referenced-message/", source: "referenced_message.attachments" });
      sources.push(...snapshotAttachmentSources(raw.referenced_message, "referenced-message/", "referenced_message."));
    }
    for (const { attachments, prefix, source } of sources) {
      for (const [index, attachment] of attachments.entries()) yield { attachment, index, prefix, source };
    }
  }
  async function collectExportAttachments(conversation, { files, report, log, stopCheck = () => false, state = createAttachmentDownloadState(), signal, budget }) {
    const check = () => {
      if (stopCheck() || signal?.aborted) throw new RunStoppedError();
    };
    let yieldedAt = performance.now();
    for (const message of conversation.messages) {
      check();
      if (performance.now() - yieldedAt >= 8) {
        await sleep(0);
        check();
        yieldedAt = performance.now();
      }
      for (const { attachment, index, prefix, source } of messageAttachmentEntries(message)) {
        check();
        if (performance.now() - yieldedAt >= 8) {
          await sleep(0);
          check();
          yieldedAt = performance.now();
        }
        const extension = String(attachment.filename || "").match(/\.[a-z0-9]{1,16}$/i)?.[0] || "";
        const filename = safeFilePart(Array.from(String(attachment.filename || "")).filter((char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127).join("")).replace(/^\.+|\.+$/g, "") || "file";
        const filePart = extension ? filename.replace(new RegExp(extension.replace(".", "\\.") + "$", "i"), "").slice(0, 80 - extension.length) + extension : filename;
        const name = `attachments/${safeFilePart(conversation.channelId)}/${safeFilePart(message.id)}/${prefix}${index + 1}-${filePart}`;
        const record = {
          channelId: conversation.channelId,
          messageId: message.id,
          attachmentId: attachment.id || null,
          filename: attachment.filename || "",
          url: attachment.url || null,
          path: name,
          source
        };
        let cacheKey, failedKey;
        try {
          const url = new URL(attachment.url);
          if (url.protocol !== "https:") throw new Error("Missing or invalid HTTPS attachment URL.");
          const discordCdn = ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname);
          const canonical = new URL(url);
          canonical.hash = "";
          if (discordCdn) for (const key of ["ex", "is", "hm"]) canonical.searchParams.delete(key);
          canonical.searchParams.sort();
          cacheKey = canonical.href;
          failedKey = url.href;
          const cached = state.cache.get(cacheKey) || state.failedUrls.get(failedKey);
          if (cached) {
            report.push({ ...record, ...cached, status: cached.status === "downloaded" ? "reused" : cached.status });
            continue;
          }
          if (state.suspendedReason) {
            report.push({ ...record, path: null, status: "skipped", error: state.suspendedReason });
            continue;
          }
          budget?.checkFile(name, Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : 0);
          log("verb", `Downloading attachment: ${attachment.filename || name}`);
          const response = await apiFetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer", signal }, log, stopCheck, { minIntervalMs: 1e3 });
          check();
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const length = Number(response.headers.get("Content-Length"));
          if (Number.isSafeInteger(length) && length >= 0) {
            try {
              budget?.checkFile(name, length);
            } catch (error) {
              response.body?.cancel().catch(() => {
              });
              throw error;
            }
          }
          const blob = await waitWithSignal(response.blob(), signal);
          check();
          budget?.setFile(name, blob.size);
          files.push({ name, blob });
          const result = { path: name, status: "downloaded", size: blob.size };
          state.cache.set(cacheKey, result);
          state.consecutiveFailures = 0;
          report.push({ ...record, ...result });
        } catch (error) {
          check();
          if (error instanceof RunStoppedError || error instanceof ZipCapacityError) throw error;
          const failure = { path: null, status: "failed", error: String(error.message || error) };
          if (failedKey) state.failedUrls.set(failedKey, failure);
          report.push({ ...record, ...failure });
          state.consecutiveFailures++;
          if (error instanceof RateLimitError || state.consecutiveFailures >= 3) {
            state.suspendedReason = error instanceof RateLimitError ? error.message : "Three consecutive attachment failures. Further attachment requests stopped for this export.";
            log("warn", state.suspendedReason);
          }
          log("warn", `Attachment unavailable: ${attachment.filename || name} (${error.message || error}).`);
        }
      }
    }
  }

  // src/features/message-collection.js
  function createMessageCollection(order, retain = (message) => ({ id: message.id, channel_id: message.channel_id })) {
    const messages = [];
    let preview = [];
    const direction = order === "asc" ? 1 : -1;
    return {
      messages,
      get length() {
        return messages.length;
      },
      add(batch) {
        if (!batch.length) return;
        for (const message of batch) messages.push(retain(message));
        const sorted = sortMessages(batch, order), next = [];
        if (preview.length === 20 && direction * compareMessageIds(sorted[0].id, preview.at(-1).id) >= 0) return;
        let oldIndex = 0, batchIndex = 0;
        while (next.length < 20 && (oldIndex < preview.length || batchIndex < sorted.length)) {
          if (batchIndex >= sorted.length || oldIndex < preview.length && direction * compareMessageIds(preview[oldIndex].id, sorted[batchIndex].id) <= 0) next.push(preview[oldIndex++]);
          else next.push(sorted[batchIndex++]);
        }
        preview = next;
      },
      finish() {
        const snapshots = new Map(preview.map((message) => [message.id, message]));
        for (let index = 0; index < messages.length; index++) {
          const snapshot = snapshots.get(messages[index].id);
          if (snapshot) messages[index] = snapshot;
        }
        preview = [];
        return messages;
      }
    };
  }

  // src/features/preserve-media.js
  function preservedContent(message) {
    const urls = messageUrls(message);
    if (!urls.length && !message.attachments?.length) return null;
    const content = urls.join("\n");
    if (content.length > 2e3) return null;
    return content;
  }

  // src/features/message-actions.js
  var emptyStats = () => ({ deleted: 0, overwritten: 0, failed: 0, alreadyGone: 0, skipped: 0 });
  var statsText = (stats) => `Deleted ${stats.deleted}; overwritten ${stats.overwritten}; ${stats.alreadyGone} already gone; ${stats.skipped} skipped; ${stats.failed} failed.`;
  function confirmMessages(messages, options, total = messages.length) {
    const overwrite = options.action === "overwrite";
    const preserve = options.action === "preserve";
    const details = messages.slice(0, 20).map((message) => `${message.id} \xB7 ${message.author?.username || "you"}: ${String(message.content || "[NO TEXT]").slice(0, 180)}${preserve ? `
Keep: ${preservedContent(message) ?? "[UNCHANGED: no media or links, or preserved text exceeds 2,000 characters]"}` : ""}`).join("\n");
    return askPopup({
      title: preserve ? "Remove text and keep URLs/images?" : overwrite ? "Overwrite message text?" : "Delete messages?",
      message: preserve ? `Remove surrounding text from up to ${total} messages, keeping HTTP/HTTPS URLs and all attached files (including images)? Text-only messages are left unchanged. No messages are deleted.` : overwrite ? `Replace the text of up to ${total} messages with the text below. Messages and attached files remain.

Replacement:
${options.overwriteText}` : `Delete up to ${total} messages matching your filters?`,
      details,
      yesText: preserve ? "Keep URLs/images" : overwrite ? "Overwrite" : "Delete",
      noText: "Cancel",
      danger: true
    });
  }
  async function applyMessageAction(message, options, stats) {
    const { token, action, overwriteText, log, stopCheck = () => false } = options;
    if (stopCheck()) return false;
    const edit = action !== "delete";
    const content = action === "preserve" ? preservedContent(message) : overwriteText;
    if (edit && (content === null || String(message.content || "") === content)) {
      stats.skipped++;
      return true;
    }
    const overwrite = edit;
    const response = await apiFetch(`${API}/channels/${message.channel_id}/messages/${message.id}`, {
      method: overwrite ? "PATCH" : "DELETE",
      headers: { Authorization: token, ...overwrite ? { "Content-Type": "application/json" } : {} },
      ...overwrite ? { body: JSON.stringify({ content, allowed_mentions: { parse: [], replied_user: false } }) } : {}
    }, log, stopCheck);
    if (response.ok) {
      stats[overwrite ? "overwritten" : "deleted"]++;
      log("verb", `${overwrite ? "Overwrote" : "Deleted"} message ${message.id}.`);
    } else if (response.status === 404) {
      stats.alreadyGone++;
    } else if (response.status === 401) {
      invalidateAuth2();
      log("error", "401 Unauthorized. Stopping.");
      return false;
    } else {
      stats.failed++;
      log("error", `${overwrite ? "Overwrite" : "Delete"} failed (${response.status}) for ${message.id}.`);
    }
    if (!stopCheck()) await sleep(rand(overwrite ? 1600 : 700, overwrite ? 2400 : 1600));
    return true;
  }

  // src/discord/message-reader.js
  function createMessageReader(token, log, stopCheck = () => false) {
    let useHistory = false;
    return async (channelId, messageId) => {
      const options = { headers: { Authorization: token } };
      if (!useHistory) {
        const response2 = await apiFetch(`${API}/channels/${channelId}/messages/${messageId}`, options, log, stopCheck);
        if (response2.status !== 403) return response2;
        useHistory = true;
      }
      if (stopCheck()) throw new RunStoppedError();
      const response = await apiFetch(`${API}/channels/${channelId}/messages?around=${messageId}&limit=3`, options, log, stopCheck);
      if (!response.ok) return response;
      const messages = await response.json();
      if (!Array.isArray(messages)) throw new Error("Discord returned invalid message history. Stopping before changes.");
      const message = messages.find((item) => item.id === messageId && item.channel_id === channelId);
      return message ? Response.json(message) : new Response(null, { status: 404 });
    };
  }

  // src/features/collected-messages.js
  async function runCollectedMessages(messages, options, stats) {
    const { token, log, stopCheck = () => false, progress = () => {
    } } = options;
    if (stopCheck()) return { stopped: true, ...stats };
    const ordered = sortMessages(messages, options.order);
    log("success", `Scan complete: ${ordered.length} matching messages collected. No messages changed during scanning.`);
    if (!ordered.length) {
      log("info", "No messages matched the selected author, channels, dates and filters. Start again to scan for new messages.");
      return { done: true, ...stats };
    }
    if (!options.skipConfirm && !await confirmMessages(ordered, options, ordered.length)) return { cancelled: true, ...stats };
    const readMessage = createMessageReader(token, log, stopCheck);
    for (const [index, snapshot] of ordered.entries()) {
      if (stopCheck()) return { stopped: true, ...stats };
      const response = await readMessage(snapshot.channel_id, snapshot.id);
      if (stopCheck()) return { stopped: true, ...stats };
      if (response.status === 401) {
        invalidateAuth2();
        return { unauthorized: true, ...stats };
      }
      if (response.status === 403) {
        stats.failed++;
        log("error", "Discord denied access to message history. Stopping; no further messages will be changed.");
        return { forbidden: true, ...stats };
      }
      if (response.status === 404) stats.alreadyGone++;
      else if (!response.ok) {
        stats.failed++;
        log("error", `Could not recheck message ${snapshot.id} (${response.status}).`);
      } else {
        const message = await response.json();
        if (message.id !== snapshot.id || message.channel_id !== snapshot.channel_id || !matchesMessage(message, options)) stats.skipped++;
        else if (!await applyMessageAction(message, options, stats)) return { ...stopCheck() ? { stopped: true } : { unauthorized: true }, ...stats };
      }
      progress(index + 1, ordered.length, options.action);
    }
    log(stopCheck() ? "warn" : "success", `${stopCheck() ? "Stopped" : "Finished"}. ${statsText(stats)}`);
    return { ...stopCheck() ? { stopped: true } : { done: true }, ...stats };
  }

  // src/features/fresh-messages.js
  async function collectFreshMessages(options, newest, collected, stats, scanned = 0) {
    const { token, guildId, channelId, log, stopCheck, progress = () => {
    } } = options;
    const inaccessible = /* @__PURE__ */ Symbol("inaccessible");
    const read = async (url, forbiddenMessage = "") => {
      const response = await apiFetch(url, { headers: { Authorization: token }, cache: "no-store" }, log, stopCheck);
      if (stopCheck()) throw new RunStoppedError();
      if (response.status === 403 && forbiddenMessage) {
        log("warn", forbiddenMessage);
        return inaccessible;
      }
      if (response.status === 401) invalidateAuth2();
      if (!response.ok) throw new Error(`Fresh message scan failed (${response.status}) for ${new URL(url).pathname}. Check your access and try again.`);
      return response.json();
    };
    let channels = [{ id: channelId }];
    if (channelId && guildId !== "@me") {
      const channel = await read(`${API}/channels/${channelId}`);
      if (channel.id !== channelId || channel.guild_id !== guildId) throw new Error("Discord returned a channel outside the selected server.");
      if (channel.nsfw && !options.includeNsfw) {
        log("info", "Fresh history skipped for this NSFW channel. Enable Include NSFW to scan it.");
        return;
      }
    }
    if (!channelId) {
      const discovered = await read(`${API}/guilds/${guildId}/channels`, "Discord denied server channel discovery (403). Continuing with channels found in search. Select individual channels to scan new messages in channels missing from search.");
      const list = discovered === inaccessible ? [] : discovered;
      if (!Array.isArray(list)) throw new Error("Discord returned an invalid channel list.");
      if (list.some((channel) => channel.guild_id && channel.guild_id !== guildId)) throw new Error("Discord returned channels for another server.");
      channels = list.filter((channel) => [0, 5].includes(channel.type) && (options.includeNsfw || !channel.nsfw));
      const active = await read(`${API}/guilds/${guildId}/threads/active`, "Discord denied active thread discovery (403). Continuing with server channels and threads found in search. Select individual threads to scan new messages in threads missing from search.");
      const threads = active === inaccessible ? [] : active.threads;
      if (!Array.isArray(threads)) throw new Error("Discord returned an invalid active thread list.");
      const parents = new Map(list.map((channel) => [channel.id, channel]));
      const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
      channels.push(...threads.filter((thread) => {
        const parent = parents.get(thread.parent_id);
        return parent && [10, 11, 12].includes(thread.type) && (!thread.guild_id || thread.guild_id === guildId) && (options.includeNsfw || !parent.nsfw);
      }));
      const selected = new Set(channels.map((channel) => channel.id));
      const readMetadata = async (id) => {
        if (!/^\d{15,22}$/.test(String(id || ""))) throw new Error("Discord returned an invalid channel ID.");
        const channel = await read(`${API}/channels/${id}`, `Discord denied channel metadata (403) for ${id}. Skipping its fresh history scan because its server and NSFW setting could not be checked.`);
        if (channel === inaccessible) return null;
        if (channel?.id !== id || channel.guild_id !== guildId) throw new Error("Discord returned a channel outside the selected server.");
        return channel;
      };
      for (const id of newest.keys()) {
        if (selected.has(id)) continue;
        let thread = threadsById.get(id);
        if (thread && (![10, 11, 12].includes(thread.type) || thread.guild_id && thread.guild_id !== guildId)) continue;
        let channel = parents.get(id) || thread || await readMetadata(id);
        if (!channel) continue;
        if ([10, 11, 12].includes(channel.type)) {
          thread = channel;
          channel = parents.get(thread.parent_id) || await readMetadata(thread.parent_id);
          if (!channel) continue;
          if (![0, 5, 15, 16].includes(channel.type)) throw new Error("Discord returned an invalid thread parent.");
          parents.set(channel.id, channel);
        } else if (![0, 5].includes(channel.type)) throw new Error("Discord returned an unsupported message channel.");
        if (options.includeNsfw || !channel.nsfw) {
          channels.push({ id });
          selected.add(id);
        }
      }
    }
    log("info", "Checking fresh channel history for messages that Discord search may not have indexed yet\u2026");
    for (const channel of channels) {
      if (!/^\d{15,22}$/.test(String(channel.id || ""))) throw new Error("Discord returned an invalid channel ID.");
      const indexed = newest.get(channel.id);
      const lower = indexed && (!options.minId || compareMessageIds(indexed, options.minId) > 0) ? indexed : options.minId;
      let before = options.maxId;
      while (!stopCheck()) {
        if (before && lower && compareMessageIds(before, lower) <= 0) break;
        const query = new URLSearchParams({ limit: "100" });
        if (before) query.set("before", before);
        const batch = await read(`${API}/channels/${channel.id}/messages?${query}`, channelId ? "" : `Discord denied message history for channel ${channel.id} (403). Skipping its fresh history scan; collected search matches will still be rechecked.`);
        if (batch === inaccessible) break;
        if (!Array.isArray(batch)) throw new Error("Discord returned invalid message history. No further messages changed.");
        if (!batch.length) break;
        if (batch.some((message) => !/^\d+$/.test(String(message?.id || "")) || message.channel_id !== channel.id)) {
          throw new Error("Discord returned invalid history messages. No further messages changed.");
        }
        const oldest = batch.reduce((id, message) => compareMessageIds(message.id, id) < 0 ? message.id : id, batch[0].id);
        if (before && compareMessageIds(oldest, before) >= 0) throw new Error("Fresh message history did not advance. Try again.");
        const seen = /* @__PURE__ */ new Set(), matching = [];
        for (const message of batch) {
          if (seen.has(message.id) || before && compareMessageIds(message.id, before) >= 0 || lower && compareMessageIds(message.id, lower) <= 0) continue;
          seen.add(message.id);
          scanned++;
          if (matchesMessage(message, options)) matching.push(message);
          else stats.skipped++;
        }
        collected.add(matching);
        progress(scanned, scanned, "Scanning");
        log("verb", `Scanned ${scanned}; collected ${collected.length} fresh and indexed matches.`);
        if (lower && compareMessageIds(oldest, lower) <= 0) break;
        before = oldest;
        if (!stopCheck()) await sleep(rand(900, 1500));
      }
      if (stopCheck()) throw new RunStoppedError();
    }
  }

  // src/features/messages.js
  async function deleteMessages(opts) {
    const stats = emptyStats();
    const stopCheck = opts.stopCheck || (() => runState.stopped);
    const options = normalizeCleanupOptions({ ...opts, stopCheck });
    const { token, authorId, guildId, channelId, content, includeNsfw, skipConfirm = false, log, progress = () => {
    } } = options;
    let pageMinId = options.minId;
    let pageMaxId = options.maxId;
    let approved = skipConfirm;
    let total = null;
    let processed = 0;
    let scanned = 0;
    const collected = createMessageCollection(options.order);
    const newest = /* @__PURE__ */ new Map();
    progress(0, 1, "Scanning");
    log("success", `Started ${options.action} \xB7 ${options.order === "asc" ? "oldest first" : "newest first"} \xB7 ${currentLabel()} (${guildId}/${channelId || "all channels"})`);
    try {
      while (!stopCheck()) {
        const base = guildId === "@me" ? `${API}/channels/${channelId}/messages/search` : `${API}/guilds/${guildId}/messages/search`;
        const query = qs([
          ["author_id", authorId],
          ["channel_id", guildId !== "@me" ? channelId : void 0],
          ["min_id", pageMinId],
          ["max_id", pageMaxId],
          ["sort_by", "timestamp"],
          ["sort_order", options.order],
          ["offset", 0],
          ["has", options.linkMode === "with" ? "link" : void 0],
          ["has", options.fileMode === "with" ? "file" : void 0],
          ["content", options.textMode === "include" ? content : void 0],
          ["include_nsfw", includeNsfw ? "true" : void 0]
        ]);
        const search = await apiFetch(`${base}?${query}`, { headers: { Authorization: token }, cache: "no-store" }, log, stopCheck);
        if (stopCheck()) break;
        if (search.status === 202) {
          let body = {};
          try {
            body = await search.json();
          } catch {
          }
          await sleep(retryMs(body.retry_after || 2));
          continue;
        }
        if (search.status === 401) {
          invalidateAuth2();
          log("error", "401 Unauthorized. Press GET next to Authorization and try again.");
          return { unauthorized: true, ...stats };
        }
        if (!search.ok) {
          log("error", `Search failed with HTTP ${search.status}.`);
          return { httpStatus: search.status, forbidden: search.status === 403, ...stats };
        }
        const data = await search.json();
        const groups = Array.isArray(data.messages) ? data.messages : [];
        const hits = groups.map((group) => Array.isArray(group) ? group.find((message) => message?.hit) || group[0] : null).filter((message) => message && /^\d+$/.test(String(message.id || "")));
        total ??= Number(data.total_results || hits.length);
        if (!hits.length) {
          if (options.freshHistory) {
            await collectFreshMessages(options, newest, collected, stats, scanned);
            return await runCollectedMessages(collected.finish(), options, stats);
          }
          if (options.collectAll) return await runCollectedMessages(collected.finish(), options, stats);
          log("success", `Finished. ${statsText(stats)}`);
          return { done: true, ...stats };
        }
        const sorted = sortMessages(hits, options.order);
        if (options.freshHistory) {
          for (const message of sorted) {
            const previous = newest.get(message.channel_id);
            if (!previous || compareMessageIds(message.id, previous) > 0) newest.set(message.channel_id, message.id);
          }
        }
        const edge = sorted.at(-1).id;
        const cursor = options.order === "asc" ? pageMinId : pageMaxId;
        if (cursor && (options.order === "asc" ? compareMessageIds(edge, cursor) <= 0 : compareMessageIds(edge, cursor) >= 0)) {
          log("error", "Discord returned a page that did not advance. Stopping to avoid repeating messages.");
          return { stalled: true, ...stats };
        }
        if (options.order === "asc") pageMinId = edge;
        else pageMaxId = edge;
        const pageSeen = /* @__PURE__ */ new Set();
        const candidates = sorted.filter((message) => {
          if (pageSeen.has(message.id) || cursor && (options.order === "asc" ? compareMessageIds(message.id, cursor) <= 0 : compareMessageIds(message.id, cursor) >= 0)) return false;
          pageSeen.add(message.id);
          return true;
        });
        const matching = candidates.filter((message) => matchesMessage(message, options));
        scanned += candidates.length;
        stats.skipped += candidates.length - matching.length;
        processed += candidates.length - matching.length;
        if (options.collectAll) {
          collected.add(matching);
          progress(scanned, Math.max(total, scanned), "Scanning");
          log("verb", `Scanned ${scanned}; collected ${collected.length} matches. No messages changed.`);
          if (!stopCheck()) await sleep(rand(900, 1500));
          continue;
        }
        if (!approved && matching.length) {
          approved = await confirmMessages(matching, options, total);
          if (!approved) {
            log("warn", "Cancelled.");
            return { cancelled: true, ...stats };
          }
        }
        for (const message of matching) {
          if (stopCheck()) break;
          if (!await applyMessageAction(message, options, stats)) {
            if (!stopCheck()) return { unauthorized: true, ...stats };
            break;
          }
          processed++;
          progress(processed, Math.max(total, processed), options.action);
        }
        if (!stopCheck()) await sleep(rand(900, 1500));
      }
    } catch (error) {
      if (!(error instanceof RunStoppedError)) throw error;
    }
    log("warn", `Stopped. ${statsText(stats)}`);
    return { stopped: true, ...stats };
  }

  // src/features/forum-threads.js
  async function readJson(url, options) {
    const response = await apiFetch(url, { headers: { Authorization: options.token } }, options.log, options.stopCheck);
    if (options.stopCheck?.()) throw new RunStoppedError();
    if (!response.ok) throw new Error(`Forum request failed (${response.status}). Check your access to this forum/thread.`);
    return response.json();
  }
  async function listForumThreads({ token, forumId, includeArchived = true, log = () => {
  }, stopCheck = () => false }) {
    if (!/^\d{15,22}$/.test(String(forumId || ""))) throw new Error("Enter a valid forum channel ID.");
    const options = { token, log, stopCheck };
    const forum = await readJson(`${API}/channels/${forumId}`, options);
    if (![15, 16].includes(forum.type) || forum.id !== forumId || !forum.guild_id) throw new Error("Select a forum or media channel, rather than an individual thread.");
    const threads = /* @__PURE__ */ new Map();
    const add = (values) => {
      if (!Array.isArray(values)) throw new Error("Discord returned an invalid thread list.");
      for (const thread of values) {
        if (thread.parent_id === forumId && thread.type === 11 && /^\d{15,22}$/.test(thread.id)) threads.set(thread.id, { ...thread, guild_id: forum.guild_id });
      }
    };
    const active = await readJson(`${API}/guilds/${forum.guild_id}/threads/active`, options);
    add(active.threads);
    if (includeArchived) {
      let before = "";
      while (!stopCheck()) {
        const query = new URLSearchParams({ limit: "100" });
        if (before) query.set("before", before);
        const archived = await readJson(`${API}/channels/${forumId}/threads/archived/public?${query}`, options);
        add(archived.threads);
        if (!archived.has_more) break;
        const times = archived.threads.map((thread) => thread.thread_metadata?.archive_timestamp).filter((value) => Number.isFinite(Date.parse(value)));
        const next = times.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
        if (!next || before && Date.parse(next) >= Date.parse(before)) throw new Error("Archived thread list did not advance. No incomplete list will be used.");
        before = next;
        await sleep(rand(900, 1500));
      }
    }
    if (stopCheck()) throw new RunStoppedError();
    return [...threads.values()].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }
  async function cleanupForumThread(opts) {
    const options = normalizeCleanupOptions({ ...opts, collectAll: true });
    const { channelId, log, stopCheck = () => false, progress = () => {
    } } = options;
    const stats = emptyStats(), collected = createMessageCollection(options.order);
    let scanned = 0;
    try {
      const thread = await readJson(`${API}/channels/${channelId}`, options);
      if (thread.id !== channelId || ![10, 11, 12].includes(thread.type)) throw new Error("Select an individual thread for thread cleanup.");
      const parent = await readJson(`${API}/channels/${thread.parent_id}`, options);
      if (!(opts.allowAnyThread ? [0, 5, 15, 16] : [15, 16]).includes(parent.type) || parent.guild_id !== options.guildId || parent.id !== thread.parent_id) throw new Error("This thread does not belong to the selected forum/server.");
      if (parent.nsfw && !options.includeNsfw) {
        log("info", "Thread cleanup skipped because its parent is NSFW. Enable Include NSFW to clean it.");
        return { done: true, ...stats };
      }
      let before = options.maxId;
      while (!stopCheck()) {
        const query = new URLSearchParams({ limit: "100" });
        if (before) query.set("before", before);
        const batch = await readJson(`${API}/channels/${channelId}/messages?${query}`, options);
        if (!Array.isArray(batch)) throw new Error("Discord returned an invalid thread message page.");
        if (!batch.length) break;
        const valid = batch.filter((message) => /^\d+$/.test(String(message.id || "")));
        if (valid.length !== batch.length) throw new Error("Thread page contains invalid message IDs. No messages changed.");
        const oldest = valid.reduce((value, message) => compareMessageIds(message.id, value) < 0 ? message.id : value, valid[0].id);
        if (before && compareMessageIds(oldest, before) >= 0) throw new Error("Thread history did not advance. No messages changed.");
        const matching = [];
        const pageSeen = /* @__PURE__ */ new Set();
        for (const message of valid) {
          if (pageSeen.has(message.id) || before && compareMessageIds(message.id, before) >= 0) continue;
          pageSeen.add(message.id);
          scanned++;
          if (matchesMessage(message, options)) matching.push(message);
          else stats.skipped++;
        }
        collected.add(matching);
        progress(scanned, scanned, "Scanning thread");
        log("verb", `Scanned ${scanned} messages in ${thread.name || channelId}; collected ${collected.length} matches.`);
        if (options.minId && compareMessageIds(oldest, options.minId) <= 0) break;
        before = oldest;
        if (!stopCheck()) await sleep(rand(900, 1500));
      }
      return await runCollectedMessages(collected.finish(), options, stats);
    } catch (error) {
      if (!(error instanceof RunStoppedError)) throw error;
      return { stopped: true, ...stats };
    }
  }

  // src/utils/csv.js
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    const input = String(text).replace(/^\uFEFF/, "");
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (char === '"') {
        if (quoted && input[i + 1] === '"') {
          field += '"';
          i++;
        } else if (quoted || !field) quoted = !quoted;
        else field += char;
      } else if (char === "," && !quoted) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && input[i + 1] === "\n") i++;
        row.push(field);
        if (row.some((value) => value !== "")) rows.push(row);
        row = [];
        field = "";
      } else field += char;
    }
    if (quoted) throw new Error("CSV has an unfinished quoted field.");
    row.push(field);
    if (row.some((value) => value !== "")) rows.push(row);
    return rows;
  }

  // src/utils/json.js
  function parseIdJson(text) {
    const input = String(text).replace(/^\uFEFF/, "");
    const parts = [];
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    let copied = 0, inString = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "-" || char >= "0" && char <= "9") {
        number.lastIndex = i;
        const match = number.exec(input);
        if (!match) continue;
        const token = match[0];
        if (/^\d{16,}$/.test(token)) {
          parts.push(input.slice(copied, i), '"', token, '"');
          copied = i + token.length;
        }
        i += token.length - 1;
      }
    }
    if (!parts.length) return JSON.parse(input);
    parts.push(input.slice(copied));
    return JSON.parse(parts.join(""));
  }

  // src/features/message-ids.js
  function snowflake(value, label) {
    if (typeof value !== "string" || !/^\d{15,22}$/.test(value.trim())) {
      throw new Error(`${label} must be a full Discord ID stored as text.`);
    }
    return value.trim();
  }
  function uniqueTargets(targets) {
    const map = /* @__PURE__ */ new Map();
    for (const target of targets) {
      const channelId = snowflake(target.channelId, "Channel ID");
      const messageId = snowflake(target.messageId, "Message ID");
      map.set(`${channelId}/${messageId}`, { channelId, messageId });
    }
    return [...map.values()];
  }
  function fromRecords(records, channelId) {
    return records.map((record) => {
      if (typeof record === "string") {
        const ref = parseMessageReference(record);
        if (!ref) return null;
        return { channelId: ref.channelId || channelId, messageId: ref.messageId };
      }
      if (!record || typeof record !== "object") return null;
      return {
        channelId: record.channel_id || record.channelId || channelId,
        messageId: record.id || record.ID || record.message_id || record.messageId
      };
    }).filter((record) => record && /^\d{15,22}$/.test(String(record.messageId || "")));
  }
  function parseMessageIds(text, channelId = "") {
    if (String(text || "").length > MAX_MESSAGE_ID_TEXT) throw new Error(`Message ID input is too large. Use at most ${MAX_MESSAGE_IDS} IDs per batch.`);
    const input = String(text || "").trim();
    if (input.split(/\r?\n/).length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} lines per batch.`);
    if (!input) return [];
    if (/^[[{]/.test(input)) {
      const parsed = parseIdJson(input);
      if (!parsed || typeof parsed !== "object") throw new Error("Choose a JSON message array or message record.");
      const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.messages) ? parsed.messages : [parsed];
      if (records.length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} message IDs per batch.`);
      return uniqueTargets(fromRecords(records, parsed.channelId || parsed.channel_id || channelId));
    }
    const values = input.split(/[\s,;]+/).filter(Boolean);
    if (values.length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} message IDs per batch.`);
    return uniqueTargets(values.map((value) => {
      const ref = parseMessageReference(value);
      if (!ref || ref.channelId && !/^(?:https?:\/\/)?(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/[^/\s]+\/\d+\/\d+\/?$/i.test(value)) {
        return null;
      }
      return { channelId: ref.channelId || channelId, messageId: ref.messageId };
    }).filter(Boolean));
  }
  async function importMessageIds(fileList, fallbackChannelId = "") {
    const files = [...fileList || []];
    const pathOf = (file) => String(file.webkitRelativePath || file.name).replace(/\\/g, "/");
    const folderOf = (filePath) => filePath.slice(0, Math.max(0, filePath.lastIndexOf("/"))).toLowerCase();
    const channelByFolder = /* @__PURE__ */ new Map();
    const targets = [];
    for (const file of files) {
      if (!/(?:^|\/)channel\.json$/i.test(pathOf(file))) continue;
      const channel = parseIdJson(await file.text());
      channelByFolder.set(folderOf(pathOf(file)), snowflake(channel.id, "Channel ID"));
    }
    let importedFiles = 0;
    for (const file of files) {
      const filePath = pathOf(file);
      const name = filePath.split("/").at(-1);
      if (!/\.(json|csv|txt)$/i.test(name) || /^(?:index|channel|user)\.json$/i.test(name)) continue;
      if (file.webkitRelativePath && !/^messages?\.(json|csv)$/i.test(name)) continue;
      const folder = folderOf(filePath);
      const channelId = channelByFolder.get(folder) || folder.match(/(?:^|\/)c?(\d{15,22})$/)?.[1] || fallbackChannelId;
      if (file.size > MAX_MESSAGE_ID_TEXT) throw new Error(`${name}: file is too large. Split it into batches of at most ${MAX_MESSAGE_IDS} message IDs.`);
      const text = await file.text();
      if (text.length > MAX_MESSAGE_ID_TEXT) throw new Error(`${name}: file is too large. Split it into smaller batches.`);
      try {
        if (/\.csv$/i.test(name)) {
          const [header = [], ...rows] = parseCsv(text);
          if (rows.length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} message IDs per batch.`);
          const normalize = (value) => value.trim().toLowerCase().replace(/[\s_]/g, "");
          const messageColumn = header.findIndex((value) => ["id", "messageid"].includes(normalize(value)));
          const channelColumn = header.findIndex((value) => normalize(value) === "channelid");
          if (messageColumn < 0) throw new Error("CSV needs an ID or Message ID column.");
          targets.push(...uniqueTargets(rows.filter((row) => /^\d{15,22}$/.test(row[messageColumn]?.trim() || "")).map((row) => ({ messageId: row[messageColumn], channelId: channelColumn < 0 ? channelId : row[channelColumn] }))));
        } else {
          targets.push(...parseMessageIds(text, channelId));
        }
        if (targets.length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} message IDs per batch.`);
        importedFiles++;
      } catch (error) {
        throw new Error(`${name}: ${error.message}`, { cause: error });
      }
    }
    if (!importedFiles) throw new Error("No message ID files found. Choose message JSON/CSV files or an extracted data package folder.");
    return uniqueTargets(targets);
  }

  // src/features/direct-messages.js
  function actionSnapshot(message, action) {
    const snapshot = { id: message.id, channel_id: message.channel_id };
    if (action !== "delete") snapshot.content = message.content;
    if (action === "preserve") {
      if (message.attachments?.length) snapshot.attachments = [{}];
      snapshot.embeds = (message.embeds || []).map((embed) => ({ url: embed.url, ...embed.image?.url ? { image: { url: embed.image.url } } : {} }));
    }
    return snapshot;
  }
  async function runDirectMessages(opts) {
    const options = normalizeCleanupOptions(opts);
    const { token, authorId, log, progress = () => {
    }, stopCheck = () => false } = options;
    const targets = uniqueTargets(opts.targets || []);
    if (!targets.length) throw new Error("Paste or import at least one message ID.");
    const stats = emptyStats();
    const collected = createMessageCollection(options.order, (message) => actionSnapshot(message, options.action));
    const readMessage = createMessageReader(token, log, stopCheck);
    const ordered = sortMessages(targets.map((target) => ({ ...target, id: target.messageId })), options.order);
    try {
      for (const [index, target] of ordered.entries()) {
        if (stopCheck()) break;
        const response = await readMessage(target.channelId, target.messageId);
        if (stopCheck()) break;
        if (response.status === 401) {
          invalidateAuth2();
          log("error", "401 Unauthorized while checking IDs.");
          return { unauthorized: true, ...stats };
        }
        if (response.status === 404) stats.alreadyGone++;
        else if (response.status === 403) {
          stats.failed++;
          log("error", "Discord denied access to message history. Stopping before changes.");
          return { forbidden: true, ...stats };
        } else if (!response.ok) {
          stats.failed++;
          log("error", `Could not check message ${target.messageId} (${response.status}).`);
        } else {
          const message = await response.json();
          if (message.id === target.messageId && message.channel_id === target.channelId && matchesMessage(message, { ...options, authorId, channelId: target.channelId })) collected.add([message]);
          else stats.skipped++;
        }
        progress(index + 1, targets.length, "Checking IDs");
        if (!stopCheck() && index < ordered.length - 1) await sleep(rand(350, 600));
      }
      if (stopCheck()) {
        log("warn", `Stopped. ${statsText(stats)}`);
        return { stopped: true, ...stats };
      }
      const matching = collected.finish();
      if (!matching.length) {
        log("success", `No matching messages of yours. ${statsText(stats)}`);
        return { done: true, ...stats };
      }
      if (!options.skipConfirm && !await confirmMessages(matching, options)) return { cancelled: true, ...stats };
      for (const [index, message] of matching.entries()) {
        if (stopCheck()) break;
        if (!await applyMessageAction(message, { ...options, stopCheck }, stats)) {
          if (!stopCheck()) return { unauthorized: true, ...stats };
          break;
        }
        progress(index + 1, matching.length, options.action === "delete" ? "Deleting" : "Editing text");
      }
    } catch (error) {
      if (!(error instanceof RunStoppedError)) throw error;
    }
    log(stopCheck() ? "warn" : "success", `${stopCheck() ? "Stopped" : "Finished"}. ${statsText(stats)}`);
    return { ...stopCheck() ? { stopped: true } : { done: true }, ...stats };
  }

  // src/features/reaction-filter.js
  function parseReactionIds(value = "") {
    const ids = /* @__PURE__ */ new Set();
    for (const item of String(value).split(/[\s,;]+/).filter(Boolean)) {
      const id = item.match(/^<a?:[^:<>\s]+:(\d{15,22})>$/)?.[1] || item;
      if (!/^\d{15,22}$/.test(id)) throw new Error("Reaction filter must contain emoji IDs or custom emoji tags, separated by commas.");
      ids.add(id);
    }
    return ids;
  }
  function matchesReaction(emoji, ids) {
    return !ids.size || ids.has(String(emoji?.id || ""));
  }

  // src/features/reactions.js
  function emojiParam(emoji) {
    return encodeURIComponent(emoji?.id ? `${emoji.name || "_"}:${emoji.id}` : emoji?.name || "");
  }
  async function removeReactions(opts) {
    const { token, channelId, startId, scanLimit, skipOwn, authorId, log, progress = () => {
    } } = opts;
    const reactionIds = parseReactionIds(opts.reactionIds);
    const authors = opts.reactionAuthorId?.trim() ? [...new Set(opts.reactionAuthorId.split(/[\s,;]+/).filter(Boolean))] : [authorId];
    if (authors.some((id) => id !== authorId && !/^\d{15,22}$/.test(id))) throw new Error("Author(s) must contain valid user IDs.");
    const ownReactions = authors.length === 1 && authors[0] === authorId;
    runState.reactionStopped = false;
    const stopCheck = () => runState.reactionStopped;
    try {
      let before = "";
      if (startId) {
        const id = toSnowflake(startId);
        if (!id) return log("error", "Start message/date is invalid.");
        before = (BigInt(id) + 1n).toString();
      }
      const targets = [];
      const preview = [];
      let scanned = 0;
      while (scanned < scanLimit && !runState.reactionStopped) {
        const limit = Math.min(100, scanLimit - scanned);
        const url = `${API}/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ""}`;
        const response = await apiFetch(url, { headers: { Authorization: token } }, log, stopCheck);
        if (stopCheck()) break;
        if (response.status === 401) {
          invalidateAuth2();
          return log("error", "401 Unauthorized. Press GET next to Authorization.");
        }
        if (!response.ok) return log("error", `History request failed with HTTP ${response.status}.`);
        const batch = await response.json();
        if (!Array.isArray(batch) || !batch.length) break;
        if (batch.some((message) => !/^\d+$/.test(String(message.id || "")))) throw new Error("Discord returned invalid reaction history IDs. No reactions changed.");
        const oldest = batch.reduce((value, message) => compareMessageIds(message.id, value) < 0 ? message.id : value, batch[0].id);
        if (before && compareMessageIds(oldest, before) >= 0) throw new Error("Reaction history did not advance. No reactions changed.");
        const pageSeen = /* @__PURE__ */ new Set();
        for (const message of batch) {
          if (pageSeen.has(message.id) || before && compareMessageIds(message.id, before) >= 0) continue;
          pageSeen.add(message.id);
          scanned++;
          if (skipOwn && message.author?.id === authorId) continue;
          const targetSeen = /* @__PURE__ */ new Set();
          for (const reaction of message.reactions || []) {
            if (!matchesReaction(reaction.emoji, reactionIds)) continue;
            const encodedEmoji = emojiParam(reaction.emoji);
            for (const reactionAuthorId of authors) {
              if (stopCheck()) break;
              const targetKey = `${encodedEmoji}/${reactionAuthorId}`;
              if (targetSeen.has(targetKey)) continue;
              const ownAuthor = reactionAuthorId === authorId;
              let matchesAuthor = !!(reaction.me || reaction.me_burst);
              if (!ownAuthor) {
                const users2 = await apiFetch(`${API}/channels/${channelId}/messages/${message.id}/reactions/${encodedEmoji}?limit=1&after=${BigInt(reactionAuthorId) - 1n}`, { headers: { Authorization: token } }, log, stopCheck);
                if (!users2.ok) throw new Error(`Could not verify reaction authors (HTTP ${users2.status}).`);
                const data = await users2.json();
                matchesAuthor = Array.isArray(data) && data.some((user) => user.id === reactionAuthorId);
                await sleep(rand(550, 900));
                if (stopCheck()) break;
              }
              if (matchesAuthor) {
                targetSeen.add(targetKey);
                if (preview.length < 20) preview.push(`${reactionAuthorId} \xB7 ${message.id} \xB7 ${reaction.emoji.name || "emoji"}${reaction.emoji.id ? ` (${reaction.emoji.id})` : ""}
${(message.content || "").slice(0, 500)}`);
                targets.push({ reactionAuthorId, messageId: message.id, encodedEmoji });
              }
            }
          }
          if (scanned >= scanLimit) break;
        }
        before = oldest;
        progress(scanned, scanLimit, "Scanning");
        await sleep(rand(1700, 2600));
      }
      if (runState.reactionStopped) return log("warn", "Reaction scan stopped.");
      if (!targets.length) return log("success", `Scanned ${scanned} messages; no reactions from the selected author were found.`);
      const approved = await askPopup({
        title: "Remove reactions?",
        message: `Remove ${targets.length} ${ownReactions ? "of your reactions" : `reactions from ${authors.join(", ")}`} found in ${scanned} scanned messages?${reactionIds.size ? `
Emoji IDs: ${[...reactionIds].join(", ")}` : ""}`,
        details: preview.join("\n\n") + (targets.length > preview.length ? `

Showing the first ${preview.length} of ${targets.length} reactions.` : ""),
        yesText: "Remove",
        noText: "Cancel",
        danger: true
      });
      if (!approved) return log("warn", "Cancelled.");
      let removed = 0, failed = 0;
      for (const target of targets) {
        if (runState.reactionStopped) break;
        const response = await apiFetch(`${API}/channels/${channelId}/messages/${target.messageId}/reactions/${target.encodedEmoji}/${target.reactionAuthorId === authorId ? "@me" : target.reactionAuthorId}`, {
          method: "DELETE",
          headers: { Authorization: token }
        }, log, stopCheck);
        if (response.ok || response.status === 204 || response.status === 404) removed++;
        else if (response.status === 401) {
          invalidateAuth2();
          log("error", "401 Unauthorized while removing reactions.");
          break;
        } else if (response.status === 403) {
          log("error", "Discord denied reaction removal. Removing another user\u2019s reactions requires Manage Messages in this channel.");
          break;
        } else failed++;
        progress(removed + failed, targets.length, "Removing");
        await sleep(rand(900, 1500));
      }
      log(runState.reactionStopped ? "warn" : "success", `Reaction run ended. Removed ${removed}; failed ${failed}.`);
    } catch (error) {
      if (!(error instanceof RunStoppedError)) throw error;
      log("warn", "Reaction run stopped.");
    }
  }

  // src/ui/deleter.html
  var deleter_default = '<div id="dmd-tabs">\n<button class="dmd-tab active" data-view="messages">Messages</button>\n<button class="dmd-tab" data-view="reactions">Reactions</button>\n<button class="dmd-tab" data-view="multi">Queue</button>\n<button class="dmd-tab" data-view="history">DM History</button>\n\n</div>\n<div id="dmd-messages" class="dmd-view"><div class="dmd-segments" id="dmd-message-modes" aria-label="Conversation type"><button type="button" data-mode="dm" class="active">DMs</button><button type="button" data-mode="channel">Channel</button><button type="button" data-mode="server">Server</button><button type="button" data-mode="forums">Forum/Thread</button></div><div id="dmd-thread-target" class="dmd-field" hidden><label for="dmd-thread-target-kind">Select targets</label><select id="dmd-thread-target-kind"><option value="forums">Browse forum</option><option value="thread">Thread IDs</option></select></div><div class="dmd-grid"><div class="dmd-field"><label for="dmd-action">Action</label><select id="dmd-action"><option value="delete">Delete messages</option><option value="overwrite">Overwrite message text</option><option value="preserve">Remove text, keep URLs/images</option></select></div>\n<div class="dmd-field"><label for="dmd-order">Message order</label><select id="dmd-order"><option value="desc">Newest Messages First</option><option value="asc">Oldest Messages First</option></select></div>\n\n<div id="dmd-overwrite-field" class="dmd-field dmd-wide" hidden><label for="dmd-overwrite-text">Replacement text</label><textarea id="dmd-overwrite-text" maxlength="2000" rows="3" placeholder="Text to replace each matching message"></textarea><div class="dmd-note">Overwrites text only. Messages and attached files remain; replacement text will not send mention notifications.</div></div>\n</div><details class="dmd-filter-group"><summary>Conversation & authorization</summary><div class="dmd-grid"><div class="dmd-field"><label>Authorization <button id="dmd-get-token" class="dmd-btn dmd-small">GET</button></label><input id="dmd-token" type="password" autocomplete="off" placeholder="Authorization token"></div>\n<div class="dmd-field"><label for="dmd-author" class="dmd-identity-label">Author(s) <span id="dmd-user-avatar" class="dmd-identity-avatar" hidden></span></label><input id="dmd-author" type="text" placeholder="User ID, user ID"></div>\n<div class="dmd-field"><label for="dmd-guild" class="dmd-identity-label">Server <span id="dmd-guild-avatar" class="dmd-identity-avatar" hidden></span></label><input id="dmd-guild" type="text" placeholder="@me or server ID"></div>\n<div class="dmd-field"><label>Channel(s)</label><input id="dmd-channel" type="text" placeholder="Channel ID, channel ID"></div></div></details><details class="dmd-filter-group"><summary>Date & message range</summary><div class="dmd-grid"><div class="dmd-field"><label for="dmd-after-kind">After</label><select id="dmd-after-kind"><option value="date">Date &amp; time</option><option value="id">Message ID</option></select><div id="dmd-after-date-field" class="dmd-start-value"><label for="dmd-after">Date &amp; time</label><input id="dmd-after" type="datetime-local"></div><div id="dmd-after-id-field" class="dmd-start-value" hidden><input id="dmd-after-message" type="text" placeholder="Message ID or Discord link" aria-label="After Message ID"></div></div><div class="dmd-field"><label for="dmd-before-kind">Before</label><select id="dmd-before-kind"><option value="date">Date &amp; time</option><option value="id">Message ID</option></select><div id="dmd-before-date-field" class="dmd-start-value"><label for="dmd-before">Date &amp; time</label><input id="dmd-before" type="datetime-local"></div><div id="dmd-before-id-field" class="dmd-start-value" hidden><input id="dmd-before-message" type="text" placeholder="Message ID or Discord link" aria-label="Before Message ID"></div></div></div></details><details class="dmd-filter-group"><summary>Text & message filters</summary><div class="dmd-grid"><div class="dmd-field"><label for="dmd-content">Text filter</label><input id="dmd-content" type="text" placeholder="Optional text"><select id="dmd-text-mode" aria-label="Text filter behavior"><option value="include">Only matching</option><option value="exclude">Keep matching text (inverse)</option></select></div>\n<div class="dmd-field"><label for="dmd-link-mode">Links</label><select id="dmd-link-mode"><option value="any">Any messages</option><option value="with">Only with links</option><option value="without">Keep messages with links</option></select><div class="dmd-pattern-options"><div><label class="dmd-help-label" for="dmd-regex-flags" tabindex="0" aria-describedby="dmd-regex-flags-help">Flags <span class="dmd-help-icon" aria-hidden="true">?</span><span class="dmd-tooltip" id="dmd-regex-flags-help" role="tooltip">Regex flags change how a pattern matches.\ni \u2014 ignore case\nm \u2014 multiline\ns \u2014 dot matches newlines\nu \u2014 Unicode\nLeave blank for case-sensitive matching.</span></label><input id="dmd-regex-flags" title="Regex flags change how a pattern matches. i: ignore case \xB7 m: multiline \xB7 s: dot matches newlines \xB7 u: Unicode. Leave blank for case-sensitive matching." aria-describedby="dmd-regex-flags-help" type="text" value="i" placeholder="i" maxlength="4" aria-label="Text regex flags"></div><div><label for="dmd-regex-mode">Match behavior</label><select id="dmd-regex-mode" aria-label="Text regex behavior"><option value="include">Only matching</option><option value="exclude">Keep matching</option></select></div></div></div>\n<div class="dmd-field"><label for="dmd-file-mode">Files</label><select id="dmd-file-mode"><option value="any">Any messages</option><option value="with">Only with files</option><option value="without">Keep messages with files</option></select></div>\n<div class="dmd-field"><label for="dmd-pinned-mode">Pinned messages</label><select id="dmd-pinned-mode"><option value="without">Keep pinned messages</option><option value="any">Include pinned messages</option><option value="with">Only pinned messages</option></select></div>\n<div class="dmd-field"><label>Search options</label><label class="dmd-check"><input id="dmd-nsfw" type="checkbox"> Include NSFW search results</label></div>\n<div class="dmd-field"><label for="dmd-text-regex">Text regex</label><input id="dmd-text-regex" type="text" maxlength="1000" placeholder="Optional pattern, without /slashes/"></div></div></details><details class="dmd-filter-group"><summary>Filename, extension & URL filters</summary><div class="dmd-grid"><div class="dmd-field"><label for="dmd-filename">File/URL filename contains</label><input id="dmd-filename" type="text" placeholder="Optional filename text"></div>\n<div class="dmd-field"><label for="dmd-asset-regex">File/URL regex</label><input id="dmd-asset-regex" type="text" maxlength="1000" placeholder="Optional filename or URL pattern"></div><div class="dmd-field"><label for="dmd-extensions">Extensions</label><input id="dmd-extensions" type="text" placeholder="png, jpg, zip"></div><div class="dmd-field"><div class="dmd-pattern-options"><div><label class="dmd-help-label" for="dmd-asset-regex-flags" tabindex="0" aria-describedby="dmd-asset-regex-flags-help">Flags <span class="dmd-help-icon" aria-hidden="true">?</span><span class="dmd-tooltip" id="dmd-asset-regex-flags-help" role="tooltip">Regex flags change how a pattern matches.\ni \u2014 ignore case\nm \u2014 multiline\ns \u2014 dot matches newlines\nu \u2014 Unicode\nLeave blank for case-sensitive matching.</span></label><input id="dmd-asset-regex-flags" title="Regex flags change how a pattern matches. i: ignore case \xB7 m: multiline \xB7 s: dot matches newlines \xB7 u: Unicode. Leave blank for case-sensitive matching." aria-describedby="dmd-asset-regex-flags-help" type="text" value="i" placeholder="i" maxlength="4" aria-label="File/URL regex flags"></div><div><label for="dmd-asset-mode">Match behavior</label><select id="dmd-asset-mode" aria-label="File/URL filter behavior"><option value="include">Only matching</option><option value="exclude">Keep matching</option></select></div></div></div></div></details><div class="dmd-scan-option"><div class="dmd-field"><label class="dmd-check"><input id="dmd-collect-all" type="checkbox" checked> Scan all matches before cleanup</label></div><div id="dmd-archived-option" hidden><div class="dmd-field"><label class="dmd-check"><input id="dmd-forum-archived" type="checkbox" checked> Include archived threads</label></div></div></div><div class="dmd-actions">\n<button id="dmd-start" class="dmd-btn dmd-green">Start</button><button id="dmd-add-queue" class="dmd-btn dmd-orange">Add to Queue</button><button id="dmd-stop" class="dmd-btn dmd-red" disabled>Stop</button>\n<button id="dmd-export-conversation" class="dmd-btn">Export Conversation</button><button id="dmd-clear-filters" class="dmd-btn">Clear Filters</button>\n</div></div>\n<div id="dmd-reactions" class="dmd-view" style="display:none"><div class="dmd-grid"><div class="dmd-field"><label>Messages to Scan</label><input id="dmd-rx-limit" type="number" min="1" max="${MAX_REACTION_SCAN}" value="1000"></div>\n<div class="dmd-field"><label for="dmd-rx-author" class="dmd-identity-label">Author(s) <span id="dmd-rx-user-avatar" class="dmd-identity-avatar" hidden></span></label><input id="dmd-rx-author" type="text" placeholder="User ID, user ID (blank for yours)" title="User whose reactions to remove. Removing another user\u2019s reactions requires Manage Messages."></div><div class="dmd-field"><label for="dmd-rx-guild" class="dmd-identity-label">Server <span id="dmd-rx-guild-avatar" class="dmd-identity-avatar" hidden></span></label><input id="dmd-rx-guild" type="text" placeholder="@me or server ID"></div><div class="dmd-field"><label>Channel(s)</label><input id="dmd-rx-channel" type="text" placeholder="Channel ID, channel ID"></div>\n<div id="dmd-rx-start-field" class="dmd-field"><label for="dmd-rx-start-kind">Start at</label><select id="dmd-rx-start-kind"><option value="id">Message ID</option><option value="date">Date & time</option></select><div id="dmd-rx-start-id-field" class="dmd-start-value"><input id="dmd-rx-start" type="text" maxlength="22" placeholder="Optional message ID" aria-label="Start at Message ID"></div><div id="dmd-rx-start-date-field" class="dmd-start-value" hidden><label for="dmd-rx-start-date">Date & time</label><input id="dmd-rx-start-date" type="datetime-local"></div></div>\n\n<div class="dmd-field"><label for="dmd-rx-filter">Reaction IDs</label><input id="dmd-rx-filter" type="text" placeholder="Blank for all reactions" title="Comma-separated emoji IDs or custom emoji tags"></div>\n<div class="dmd-field"><label>Filter</label><label class="dmd-check"><input id="dmd-rx-skipown" type="checkbox"> Skip messages you wrote</label></div>\n</div><div class="dmd-actions"><button id="dmd-rx-go" class="dmd-btn dmd-green">Scan and remove</button><button id="dmd-rx-stop" class="dmd-btn dmd-red" disabled>Stop</button></div></div>\n<div id="dmd-multi" class="dmd-view" style="display:none"><div class="dmd-segments" id="dmd-queue-modes" aria-label="Queue type"><button type="button" data-mode="multi" class="active">Queue</button><button type="button" data-mode="ids">Message IDs</button><button type="button" data-mode="server">Server</button></div><div id="dmd-queue-server-inputs" hidden><div class="dmd-field"><label for="dmd-server-id" class="dmd-identity-label">Server ID <span id="dmd-server-avatar" class="dmd-identity-avatar" hidden></span></label><div class="dmd-add-row"><input id="dmd-server-id" type="text" placeholder="Server ID" maxlength="22"><button id="dmd-server-add" class="dmd-btn">Add Server</button></div></div><div class="dmd-actions"><button id="dmd-server-current" class="dmd-btn">Current Server</button></div></div><div id="dmd-multi-list"></div><div class="dmd-actions"><button id="dmd-multi-start" class="dmd-btn dmd-green">Start Queue</button><button id="dmd-multi-stop" class="dmd-btn dmd-red" disabled>Stop Queue</button><button id="dmd-multi-clear" class="dmd-btn">Clear Queue</button><button id="dmd-multi-export" class="dmd-btn">Export Conversations</button></div>\n</div>\n<div id="dmd-ids" class="dmd-view" style="display:none"><div class="dmd-field"><label for="dmd-id-input">Message IDs or links</label><textarea id="dmd-id-input" rows="5" maxlength="1200000" aria-describedby="dmd-id-limit" placeholder="Paste message IDs or Discord message links (one per line)"></textarea><div id="dmd-id-limit" class="dmd-note">Maximum 10,000 lines or message IDs per batch.</div></div>\n\n<div class="dmd-actions"><button id="dmd-id-import" class="dmd-btn">Import ID file</button><button id="dmd-id-package" class="dmd-btn">Import Data Package</button><button id="dmd-id-clear" class="dmd-btn">Clear IDs</button><span id="dmd-id-count" class="dmd-muted">0 IDs</span></div>\n<input id="dmd-id-files" type="file" accept=".json,.csv,.txt" multiple hidden><input id="dmd-id-folder" type="file" webkitdirectory directory multiple hidden>\n<div class="dmd-actions"><button id="dmd-id-start" class="dmd-btn dmd-green">Run IDs</button><button id="dmd-id-stop" class="dmd-btn dmd-red" disabled>Stop</button></div>\n</div>\n<div id="dmd-forums" class="dmd-view" style="display:none"><div class="dmd-grid"><div class="dmd-field"><label for="dmd-forum-id">Forum channel ID</label><input id="dmd-forum-id" type="text" placeholder="Forum or media channel ID"></div></div>\n<div class="dmd-actions"><button id="dmd-forum-load" class="dmd-btn">Load threads</button><button id="dmd-forum-stop" class="dmd-btn dmd-red" disabled>Stop</button></div>\n<div class="dmd-field"><label for="dmd-forum-list">Select threads</label><select id="dmd-forum-list" multiple size="8"></select></div>\n\n<div class="dmd-actions"><button id="dmd-forum-run" class="dmd-btn dmd-green">Clean selected threads</button><button id="dmd-forum-queue" class="dmd-btn">Add selected to queue</button><button id="dmd-forum-export" class="dmd-btn">Export Conversation</button></div>\n</div>\n<div id="dmd-progress-dock" aria-label="Cleanup progress"><div class="dmd-progress-area" data-progress-view="messages"><progress id="dmd-progress" max="1" value="0" aria-label="messages progress"></progress><div class="dmd-progress-meta"><span id="dmd-forum-status" class="dmd-muted"></span><span id="dmd-pct">0%</span></div></div>\n<div class="dmd-progress-area" data-progress-view="multi" hidden><progress id="dmd-multi-progress" max="1" value="0" aria-label="multi progress"></progress><div class="dmd-progress-meta"><span id="dmd-multi-count" class="dmd-muted">0 queued</span><span id="dmd-multi-pct">0%</span></div><div id="dmd-multi-status" class="dmd-muted"></div></div>\n<div class="dmd-progress-area" data-progress-view="ids" hidden><progress id="dmd-id-progress" max="1" value="0" aria-label="ids progress"></progress><div class="dmd-progress-meta"><span id="dmd-id-status" class="dmd-muted"></span><span id="dmd-id-pct">0%</span></div></div>\n<div class="dmd-progress-area" data-progress-view="reactions" hidden><progress id="dmd-rx-progress" max="1" value="0" aria-label="reactions progress"></progress><div class="dmd-progress-meta"><span id="dmd-rx-phase" class="dmd-muted"></span><span id="dmd-rx-pct">0%</span></div></div>\n<div class="dmd-progress-area" data-progress-view="history" hidden><progress id="dmh-progress" max="1" value="0" aria-label="DM cleanup progress"></progress><div class="dmd-progress-meta"><span id="dmh-progress-status"></span><span id="dmh-pct">0%</span></div></div>\n</div>\n<section id="dmd-log-area" aria-label="Logs"><div class="dmd-log-toolbar"><span>Logs</span><div><button id="dmd-export-log" class="dmd-btn dmd-small" aria-label="Export logs">Export</button><button id="dmd-clear" class="dmd-btn dmd-small" aria-label="Clear logs">Clear</button></div></div><pre id="dmd-log" role="log" aria-label="Logs" aria-live="polite"></pre></section>\n<div id="dmd-resize-left" data-resize-corner="left" title="Resize from bottom left" aria-label="Resize from bottom left"></div><div id="dmd-resize-handle" data-resize-corner="right" title="Resize from bottom right" aria-label="Resize from bottom right"></div>\n';

  // src/ui/deleter.css
  var deleter_default2 = `#dmd-toolbar-btn {
  width: 32px !important;
  height: 32px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  border: 0 !important;
  border-radius: 4px !important;
  background: transparent !important;
  color: var(--interactive-normal,#aaa) !important;
  cursor: pointer !important;
  padding: 0 !important;
  margin: 0 2px !important;
}
#dmd-toolbar-btn:hover {
  background: #ffffff0d !important;
  color: #fff !important;
}
#dmd-panel {
  --bg:#2c2c2b;
  --surface:#343433;
  --hover:#ffffff08;
  --line:#ffffff13;
  --text:#eeeeea;
  --muted:#a8a8a2;
  position: fixed;
  top: 62px;
  right: 18px;
  width: min(660px, calc(100vw - 36px));
  height: min(480px, calc(100vh - 80px));
  display: none;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  border: 1px solid #4b4b49;
  border-radius: 8px;
  box-shadow: 0 20px 70px #0006;
  z-index: 2147483646;
  font:
    14px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  overflow: hidden;
  container-type: inline-size;
  color-scheme: dark;
}
#dmd-panel * {
  box-sizing: border-box;
}
#dmd-panel [hidden] {
  display: none !important;
}
#dmd-tabs {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--line);
  background: #343433;
  position: relative;
}
.dmd-tab {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #a5a5a2;
  font:
    500 12px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  padding: 12px 13px;
  white-space: nowrap;
  cursor: pointer;
}
.dmd-tab:hover {
  color: #eee;
  background: #ffffff06;
}
.dmd-tab.active {
  color: #efefed;
  border-bottom-color: #d4d4d0;
}
.dmd-view {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 28px 32px;
  scrollbar-width: thin;
  scrollbar-color: #484846 transparent;
}
.dmd-view-title {
  margin: 0 0 18px;
  font-size: 25px;
  letter-spacing: -.6px;
  font-weight: 650;
  line-height: 1.3;
  color: #f0f0ec;
}
.dmd-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 20px 20px;
}
.dmd-field {
  min-width: 0;
}
#dmd-thread-target {
  margin-bottom: 20px;
}
.dmd-field label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #aaa9a5;
  margin: 0 0 7px;
}
.dmd-field input[type=text],
.dmd-field input[type=password],
.dmd-field input[type=datetime-local],
.dmd-field input[type=number],
.dmd-field select,
.dmd-field textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid #50504d;
  border-radius: 4px;
  background: #3a3a39;
  color: #eeeeea;
  padding: 8px 10px;
  font: inherit;
  outline: none;
  transition: border-color .15s;
}
.dmd-field input {
  height: 36px;
}
.dmd-field input::placeholder,
.dmd-field textarea::placeholder {
  color: #979790;
}
#dmd-panel select:not([multiple]) {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%239b9b98' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 14px;
  height: 36px;
}
.dmd-field input + select,
.dmd-field input + label {
  margin-top: 8px;
}
.dmd-field textarea {
  resize: vertical;
  line-height: 1.6;
}
.dmd-field input:focus,
.dmd-field select:focus,
.dmd-field textarea:focus {
  border-color: #8b85ed;
  box-shadow: 0 0 0 2px #8b85ed22;
}
#dmd-panel button:focus-visible,
#dmd-panel summary:focus-visible,
.dmd-help-label:focus-visible {
  outline: 2px solid #8b85ed;
  outline-offset: 3px;
}
.dmd-check {
  display: flex !important;
  align-items: center;
  gap: 8px;
  font-weight: 400 !important;
  margin: 8px 0 !important;
}
.dmd-check input[type=checkbox] {
  width: 14px;
  height: 14px;
  flex: none;
  margin: 0;
  accent-color: #8b85ed;
}
.dmd-pattern-options {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
.dmd-field > input + .dmd-pattern-options {
  margin-top: 12px;
}
.dmd-pattern-options input {
  text-align: center;
}
.dmd-pattern-options input,
.dmd-pattern-options select {
  margin-top: 0 !important;
}
.dmd-btn {
  border: 1px solid #545450;
  border-radius: 4px;
  padding: 8px 12px;
  background: #414140;
  color: #d8d8d3;
  font:
    500 12px/1.4 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  cursor: pointer;
  transition: background .15s;
}
.dmd-btn:hover:not(:disabled) {
  background: #4b4b49;
}
.dmd-btn:disabled {
  opacity: .35;
  cursor: not-allowed;
}
.dmd-green {
  background: #eeeeea;
  border-color: #eeeeea;
  color: #2c2c2b;
}
.dmd-green:hover:not(:disabled) {
  background: #ffffff;
}
.dmd-red {
  color: #e99792;
  background: #3b2524;
  border-color: #60302c;
}
.dmd-red:hover:not(:disabled) {
  background: #4b2b29;
}
.dmd-small {
  padding: 2px 7px;
  font-size: 10px;
  margin-left: 5px;
}
.dmd-actions {
  border-top: 1px solid var(--line);
  margin-top: 24px;
  padding-top: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dmd-muted,
.dmd-note {
  color: #a0a09a;
  font-size: 12px;
}
.dmd-note {
  margin-top: 10px;
}
.dmd-wide {
  grid-column: 1/-1;
}
#dmd-panel .dmd-filter-group {
  margin-top: 6px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  overflow: visible;
}
#dmd-panel .dmd-filter-group summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 3px;
  color: #c4c4bf;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  list-style: none;
}
#dmd-panel .dmd-filter-group summary::-webkit-details-marker {
  display: none;
}
#dmd-panel .dmd-filter-group summary::before {
  content: "";
  width: 6px;
  height: 6px;
  border-right: 1.5px solid #878782;
  border-bottom: 1.5px solid #878782;
  transform: rotate(-45deg);
  flex: none;
  margin-left: 3px;
}
#dmd-panel .dmd-filter-group[open] summary::before {
  transform: rotate(45deg);
  margin-top: -4px;
}
#dmd-panel .dmd-filter-group summary:hover {
  background: var(--hover);
  border-radius: 4px;
}
.dmd-filter-group > .dmd-grid,
.dmd-filter-group > .dmd-add-row {
  padding: 12px 0 20px 20px;
}
.dmd-scan-option {
  margin-top: 20px;
}
.dmd-add-row {
  display: flex;
  align-items: end;
  gap: 10px;
}
.dmd-add-row > input,
.dmd-add-row > .dmd-field {
  flex: 1;
  min-width: 0;
}
.dmd-add-row > .dmd-btn {
  flex: none;
  min-height: 36px;
  white-space: nowrap;
}
#dmd-multi-list {
  max-height: 240px;
  overflow: auto;
  margin-top: 22px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #343433;
}
.dmd-queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}
.dmd-queue-row:last-child {
  border-bottom: 0;
}
.dmd-queue-index {
  width: 22px;
  color: #777773;
}
.dmd-queue-info {
  flex: 1;
  min-width: 0;
}
.dmd-queue-title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dmd-queue-ids {
  font-size: 11px;
  color: #858580;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#dmd-forum-list {
  margin-top: 8px;
}
#dmd-forum-list option {
  padding: 8px;
}
#dmd-progress-dock {
  flex: none;
  background: #343433;
  border-top: 1px solid var(--line);
  padding: 14px 24px 10px;
}
#dmd-panel .dmd-progress-area progress {
  appearance: none;
  display: block;
  width: 100%;
  height: 4px;
  border: 0;
  border-radius: 2px;
  overflow: hidden;
  background: #50504d;
}
#dmd-panel progress::-webkit-progress-bar {
  background: #50504d;
}
#dmd-panel progress::-webkit-progress-value {
  background: #8b85ed;
}
#dmd-panel progress::-moz-progress-bar {
  background: #8b85ed;
}
.dmd-progress-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  font-size: 11px;
  color: #a0a09a;
}
#dmd-multi-status:not(:empty) {
  margin-top: 6px;
  font-size: 11px;
}
#dmd-log {
  display: block;
  flex: 0 0 126px;
  min-height: 90px;
  max-height: 26%;
  overflow: auto;
  background: #292928;
  border-top: 1px solid var(--line);
  padding: 10px 24px 14px;
  font:
    11px/1.65 Menlo,
    Consolas,
    monospace;
  white-space: pre-wrap;
  margin: 0;
  scrollbar-width: thin;
}
#dmd-log:empty::after {
  content: "No activity yet. Run an action to see updates here.";
  font:
    12px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  color: #91918a;
}
.log-success {
  color: #88b99e;
}
.log-error {
  color: #e99792;
}
.log-warn {
  color: #d0b685;
}
.log-info {
  color: #91b9ce;
}
.log-verb {
  color: #a6a6a0;
}
.dmd-help-label {
  position: relative;
  width: max-content;
  cursor: help;
}
.dmd-help-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border: 1px solid #777772;
  border-radius: 50%;
  font-size: 9px;
  margin-left: 2px;
  color: #92928d;
}
#dmd-panel .dmd-tooltip {
  position: absolute;
  left: 0;
  bottom: calc(100% + 9px);
  width: 225px;
  max-width: calc(100vw - 80px);
  padding: 10px 12px;
  z-index: 30;
  background: #414140;
  border: 1px solid #565651;
  border-radius: 5px;
  box-shadow: 0 4px 16px #0007;
  color: #e4e4dc;
  font-size: 12px;
  line-height: 1.6;
  font-weight: 400;
  white-space: normal;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
#dmd-panel .dmd-help-label:hover .dmd-tooltip,
#dmd-panel .dmd-help-label:focus .dmd-tooltip {
  visibility: visible;
  opacity: 1;
}
#dmd-panel [data-resize-corner] {
  position: absolute;
  bottom: 0;
  width: 26px;
  height: 26px;
  z-index: 20;
  touch-action: none;
}
#dmd-resize-handle {
  right: 0;
  cursor: nwse-resize;
}
#dmd-resize-left {
  left: 0;
  cursor: nesw-resize;
}
#dmd-panel [data-resize-corner]::after {
  content: "";
  position: absolute;
  bottom: 6px;
  width: 9px;
  height: 9px;
  border-bottom: 2px solid #979790;
}
#dmd-resize-handle::after {
  right: 6px;
  border-right: 2px solid #979790;
}
#dmd-resize-left::after {
  left: 6px;
  border-left: 2px solid #979790;
}
#dmd-panel [data-resize-corner]:hover::after {
  border-color: #eeeeea;
}
.dmd-confirm-overlay {
  position: fixed;
  inset: 0;
  background: #0009;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483647;
  padding: 20px;
}
.dmd-confirm-box {
  width: min(560px, calc(100vw - 40px));
  max-height: calc(100vh - 40px);
  overflow: auto;
  background: #343433;
  color: #eeeeea;
  border: 1px solid #545450;
  border-radius: 6px;
  box-shadow: 0 18px 60px #0008;
  padding: 24px;
  font:
    14px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
.dmd-confirm-title {
  font-size: 19px;
  font-weight: 600;
  margin-bottom: 10px;
}
.dmd-confirm-message {
  color: #aaa9a2;
  white-space: pre-wrap;
}
.dmd-confirm-details {
  margin: 16px 0 0;
  background: #2c2c2b;
  border: 1px solid #484845;
  border-radius: 4px;
  padding: 12px;
  max-height: 280px;
  overflow: auto;
  color: #aaa9a2;
  font:
    12px/1.5 Menlo,
    Consolas,
    monospace;
  white-space: pre-wrap;
}
.dmd-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
@container (max-width:700px) {
  #dmd-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    padding-right: 24px;
  }
  .dmd-tab {
    padding: 10px 5px;
    font-size: 12px;
  }
  .dmd-view {
    padding: 22px 24px;
  }
}
@container (max-width:440px) {
  .dmd-grid {
    grid-template-columns: 1fr;
  }
  .dmd-add-row {
    flex-wrap: wrap;
  }
  .dmd-view {
    padding: 18px;
  }
  .dmd-filter-group > .dmd-grid {
    padding-left: 12px;
  }
  #dmd-log {
    flex-basis: 100px;
  }
}
#dmd-panel input:not([type=checkbox]):not([type=file]),
#dmd-panel select:not([multiple]) {
  min-width: 0;
  max-width: 100%;
  height: 36px;
  min-height: 36px;
  max-height: 36px;
}
#dmd-panel textarea {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  min-height: 90px;
  max-height: min(320px, 40vh);
  resize: vertical;
  overflow: auto;
}
#dmd-panel select[multiple] {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  min-height: 100px;
  max-height: min(320px, 40vh);
  overflow: auto;
}
#dmd-panel #dmd-log {
  overflow-y: auto;
  overflow-x: hidden;
  overflow-wrap: anywhere;
}
#dmd-panel .dmd-actions + .dmd-field {
  margin-top: 20px;
}
#dmd-panel .dmd-native-select {
  display: none !important;
}
#dmd-panel .dmd-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 8px 10px;
  border: 1px solid #50504d;
  border-radius: 4px;
  background: #3a3a39;
  color: #eeeeea;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
#dmd-panel .dmd-select-trigger span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#dmd-panel .dmd-select-trigger::after {
  content: "";
  width: 6px;
  height: 6px;
  border-right: 1.5px solid #a8a8a2;
  border-bottom: 1.5px solid #a8a8a2;
  transform: rotate(45deg);
  margin: 0 3px 3px;
  flex: none;
}
#dmd-panel .dmd-select-trigger:hover,
#dmd-panel .dmd-select-trigger[aria-expanded=true] {
  background: #414140;
  border-color: #72726d;
}
#dmd-panel input + .dmd-native-select + .dmd-select-trigger {
  margin-top: 8px;
}
.dmd-select-menu {
  position: fixed;
  z-index: 2147483647;
  overflow-y: auto;
  padding: 5px;
  background: #414140;
  border: 1px solid #565651;
  border-radius: 6px;
  box-shadow: 0 8px 30px #0006;
  color: #eeeeea;
  font:
    13px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  scrollbar-width: thin;
}
.dmd-select-menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 3px;
  padding: 8px 26px 8px 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  position: relative;
}
.dmd-select-menu button:hover,
.dmd-select-menu button:focus {
  background: #ffffff0e;
  outline: none;
}
.dmd-select-menu button[aria-selected=true]::after {
  content: "\\2713";
  position: absolute;
  right: 9px;
  color: #b0aafa;
}
.dmd-select-menu button:disabled {
  opacity: .4;
  cursor: default;
}
#dmd-panel .dmd-identity-label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 20px;
}
#dmd-panel .dmd-identity-avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #55554f;
  color: #eeeeea;
  font-size: 10px;
  overflow: hidden;
  flex: none;
}
#dmd-panel .dmd-identity-avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
#dmd-panel > .dmd-confirm-overlay {
  position: absolute;
  inset: 0;
  padding: 18px;
  border-radius: inherit;
}
#dmd-panel .dmd-confirm-box {
  width: min(560px, 100%);
  max-height: 100%;
  min-width: 0;
}
#dmd-panel .dmd-field > select + .dmd-pattern-options,
#dmd-panel .dmd-select-trigger + .dmd-pattern-options {
  margin-top: 12px;
}
#dmd-panel .dmd-segments {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: #343433;
  border: 1px solid #4b4b49;
  border-radius: 6px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}
#dmd-panel .dmd-segments button {
  flex: 1;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #a8a8a2;
  padding: 7px 10px;
  font:
    500 12px/1.4 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  cursor: pointer;
}
#dmd-panel .dmd-segments button.active {
  background: #50504d;
  color: #eeeeea;
}
#dmd-panel .dmd-segments button:hover {
  color: #eeeeea;
}
#dmd-panel .dmd-subview {
  margin-top: 24px;
}
#dmd-panel #dmd-tabs {
  display: flex;
  flex-wrap: nowrap;
}
#dmd-panel .dmd-tab {
  flex: 1;
}
.dmd-calendar {
  position: fixed;
  z-index: 2147483647;
  width: 290px;
  max-height: calc(100vh - 16px);
  overflow: auto;
  padding: 12px;
  background: #414140;
  color: #eeeeea;
  border: 1px solid #565651;
  border-radius: 6px;
  box-shadow: 0 8px 30px #0006;
  font:
    13px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
.dmd-calendar button {
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 6px;
  cursor: pointer;
}
.dmd-calendar button:hover,
.dmd-calendar button:focus-visible {
  background: #ffffff12;
  outline: 1px solid #8b85ed;
}
.dmd-calendar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.dmd-calendar-header span {
  font-weight: 600;
}
.dmd-calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  text-align: center;
}
.dmd-calendar-grid span {
  color: #a8a8a2;
  font-size: 11px;
  padding: 4px;
}
.dmd-calendar-grid .outside {
  color: #92928e;
}
.dmd-calendar-grid .selected {
  background: #8b85ed;
  color: #fff;
}
.dmd-calendar-time {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid #565651;
  margin-top: 10px;
  padding-top: 10px;
}
.dmd-calendar-time span {
  margin-right: auto;
}
.dmd-calendar input {
  width: 48px;
  padding: 5px;
  background: #343433;
  color: #eeeeea;
  border: 1px solid #565651;
  border-radius: 4px;
  font: inherit;
}
.dmd-calendar-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
}
.dmd-calendar-footer button:last-child {
  background: #eeeeea;
  color: #2c2c2b;
  padding: 6px 12px;
}
.dmd-queue-avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 50%;
  background: var(--surface);
  display: grid;
  place-items: center;
  position: relative;
  overflow: hidden;
  color: var(--muted);
}
.dmd-queue-avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dmd-channel-picker {
  position: relative;
  min-width: 0;
}
.dmd-channel-menu {
  position: fixed;
  z-index: 2147483647;
  overflow: auto;
  padding: 10px;
  background: #343433;
  color: #eeeeea;
  border: 1px solid #565651;
  border-radius: 6px;
  box-shadow: 0 8px 30px #0006;
  font:
    13px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  color-scheme: dark;
}
.dmd-channel-menu[hidden] {
  display: none !important;
}
.dmd-channel-menu input[type=search] {
  width: 100%;
  padding: 8px;
  border: 1px solid #565651;
  border-radius: 4px;
  background: #393938;
  color: inherit;
  font: inherit;
}
.dmd-channel-menu input[type=checkbox] {
  width: 14px;
  height: 14px;
  accent-color: #8b85ed;
}
.dmd-channel-choices {
  max-height: 220px;
  overflow: auto;
  margin: 8px 0;
  scrollbar-width: thin;
}
.dmd-channel-option {
  display: flex !important;
  align-items: center;
  gap: 9px;
  padding: 7px 4px;
  margin: 0 !important;
  color: #eeeeea !important;
  cursor: pointer;
}
.dmd-channel-option input {
  flex: 0 0 auto;
}
.dmd-channel-option span {
  overflow-wrap: anywhere;
}
.dmd-channel-option:hover {
  background: #ffffff08;
}
.dmd-channel-menu [hidden] {
  display: none !important;
}
.dmd-orange {
  background: #bd7945;
  border-color: #cc8b56;
  color: #fff8f0;
}
.dmd-orange:hover:not(:disabled) {
  background: #ce8951;
}
.dmd-start-value {
  margin-top: 10px;
}
.dmd-export-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 200px;
  overflow: auto;
  margin: 14px 0;
}
.dmd-export-formats {
  border: 1px solid #545450;
  border-radius: 4px;
  display: flex;
  gap: 20px;
  padding: 10px 12px;
}
.dmd-export-formats legend {
  color: #aaa9a2;
}
#dmd-panel #dmd-log {
  scrollbar-color: #61615c #292928;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}
#dmd-panel #dmd-log::-webkit-scrollbar {
  width: 10px;
}
#dmd-panel #dmd-log::-webkit-scrollbar-track {
  background: transparent;
  margin: 8px 0 26px;
}
#dmd-panel #dmd-log::-webkit-scrollbar-thumb {
  background: #61615c;
  border: 3px solid #292928;
  border-radius: 10px;
  min-height: 28px;
}
#dmd-panel #dmd-log::-webkit-scrollbar-thumb:hover {
  background: #85857d;
}
#dmd-panel #dmd-log::-webkit-scrollbar-thumb:active {
  background: #a4a49b;
}
#dmd-panel #dmd-log::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}
#dmd-panel #dmd-log::-webkit-scrollbar-corner {
  background: transparent;
}
@supports selector(::-webkit-scrollbar) {
  #dmd-panel #dmd-log {
    scrollbar-width: auto;
    scrollbar-color: auto;
  }
}
.dmd-scan-option {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  align-items: center;
}
#dmd-panel .dmd-progress-area {
  height: 48px;
}
.dmd-progress-meta {
  min-height: 16px;
}
#dmd-multi-status {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 14px;
}
#dmd-panel .dmd-tooltip {
  width: 260px;
  white-space: pre-line;
  line-height: 1.75;
  padding: 12px 14px;
}
#dmd-reactions > .dmd-grid {
  gap: 12px 16px;
}
#dmd-reactions .dmd-start-value {
  margin-top: 8px;
}
#dmd-rx-start-field {
  display: grid;
  grid-template-columns: minmax(100px, .8fr) minmax(0, 1.2fr);
  gap: 0 8px;
}
#dmd-rx-start-field > label {
  grid-column: 1/-1;
}
#dmd-rx-start-field .dmd-start-value {
  margin-top: 0;
  min-width: 0;
}
#dmd-rx-start-date-field > label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
#dmd-log-area {
  display: flex;
  flex-direction: column;
  flex: 0 0 150px;
  min-height: 110px;
  max-height: 30%;
  background: #292928;
  border-top: 1px solid var(--line);
}
.dmd-log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 24px;
  color: #a4a49f;
  font-size: 11px;
}
.dmd-log-toolbar > div {
  display: flex;
  gap: 6px;
}
.dmd-log-toolbar .dmd-btn {
  padding: 3px 8px;
  min-height: 24px;
  background: transparent;
  border-color: transparent;
  color: #b6b6ae;
}
.dmd-log-toolbar .dmd-btn:hover {
  background: #ffffff0b;
  border-color: #50504d;
}
#dmd-log-area #dmd-log {
  flex: 1;
  min-height: 0;
  max-height: none;
  border-top: 0;
  padding-top: 4px;
}
.dmd-export-range {
  border: 1px solid #545450;
  border-radius: 4px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 12px;
  margin: 12px 0;
}
.dmd-export-range legend {
  color: #aaa9a2;
}
.dmd-export-range [role=alert] {
  grid-column: 1/-1;
  color: #ffaaa5;
}
.dmd-export-range .dmd-field {
  min-width: 0;
}
`;

  // src/ui/deleter.js
  function initDeleter() {
    if (document.getElementById("dmd-panel")) return;
    insertCss(deleter_default2);
    const btn = document.createElement("button");
    btn.id = "dmd-toolbar-btn";
    btn.type = "button";
    btn.title = "Del-Discord v1 \u2014 Delete Messages";
    btn.setAttribute("aria-label", "Delete Messages");
    btn.innerHTML = trashIcon();
    const panel = document.createElement("div");
    panel.id = "dmd-panel";
    panel.innerHTML = deleter_default.replace("${MAX_REACTION_SCAN}", String(MAX_REACTION_SCAN));
    document.body.appendChild(panel);
    const messagesView = panel.querySelector("#dmd-messages");
    const forumsView = panel.querySelector("#dmd-forums");
    forumsView.className = "dmd-subview";
    messagesView.appendChild(forumsView);
    const queueView = panel.querySelector("#dmd-multi");
    const queueBody = document.createElement("div");
    queueBody.id = "dmd-queue-conversations";
    [...queueView.children].filter((node) => node.id !== "dmd-queue-modes").forEach((node) => queueBody.appendChild(node));
    queueView.appendChild(queueBody);
    const idsView = panel.querySelector("#dmd-ids");
    idsView.className = "dmd-subview";
    queueView.appendChild(idsView);
    let messageMode = "dm", queueMode = "multi";
    const domCache = /* @__PURE__ */ new Map();
    const $ = (q) => {
      if (domCache.has(q)) return domCache.get(q);
      const node = panel.querySelector(q);
      domCache.set(q, node);
      return node;
    };
    const savedSettings = installSavedSettings(panel, { getMode: () => messageMode, setMode: (value) => {
      messageMode = value;
    }, onReset: () => {
      syncViews();
      fillContext();
    }, onStorageError: () => log("warn", "Messages settings could not be saved locally. Changes may be lost on refresh.") });
    $("#dmd-clear-filters").onclick = savedSettings.clear;
    const history = initHistory(panel, { deleteConversations: (entries) => deleteHistoryConversations(entries) });
    const identityCache = /* @__PURE__ */ new Map();
    const identityPreviews = installIdentityPreviews($, { cache: identityCache });
    const reactionPreviews = installIdentityPreviews($, { author: "#dmd-rx-author", guild: "#dmd-rx-guild", userBadge: "#dmd-rx-user-avatar", guildBadge: "#dmd-rx-guild-avatar", cache: identityCache });
    const queueServerPreview = installIdentityPreviews($, { author: null, guild: "#dmd-server-id", userBadge: null, guildBadge: "#dmd-server-avatar", cache: identityCache });
    enhanceSelects(panel);
    enhanceCalendars(panel);
    const channelPickers = installChannelPickers($, () => messageMode !== "thread");
    const logBox = $("#dmd-log");
    const { log, logEntries } = createLog(logBox);
    const resolveBoundary = (messageValue, dateValue, channelId, side) => {
      const messageText = String(messageValue || "").trim();
      if (messageText) {
        const ref = parseMessageReference(messageText);
        if (!ref) throw new Error(`${side} message must be a Discord message ID or message link.`);
        if (ref.channelId && channelId && ref.channelId !== channelId) {
          log("warn", `${side} message link is for channel ${ref.channelId}, but the selected channel is ${channelId}. Using the message ID anyway.`);
        }
        return ref.messageId;
      }
      return String(dateValue || "").trim();
    };
    const getRange = (channelId) => ({
      minId: resolveBoundary($("#dmd-after-kind").value === "id" ? $("#dmd-after-message").value : "", $("#dmd-after-kind").value === "date" ? $("#dmd-after").value : "", channelId, "After"),
      maxId: resolveBoundary($("#dmd-before-kind").value === "id" ? $("#dmd-before-message").value : "", $("#dmd-before-kind").value === "date" ? $("#dmd-before").value : "", channelId, "Before")
    });
    const getCleanupOptions = (channelId) => normalizeCleanupOptions({
      freshHistory: true,
      ...getRange(channelId),
      authorIds: parseIdList($("#dmd-author").value, "Author(s)"),
      action: $("#dmd-action").value,
      order: $("#dmd-order").value,
      overwriteText: $("#dmd-overwrite-text").value,
      content: $("#dmd-content").value,
      textMode: $("#dmd-text-mode").value,
      linkMode: $("#dmd-link-mode").value,
      fileMode: $("#dmd-file-mode").value,
      pinnedMode: $("#dmd-pinned-mode").value,
      includeNsfw: $("#dmd-nsfw").checked,
      filename: $("#dmd-filename").value,
      extensions: $("#dmd-extensions").value,
      textRegex: $("#dmd-text-regex").value,
      regexFlags: $("#dmd-regex-flags").value,
      regexMode: $("#dmd-regex-mode").value,
      assetRegex: $("#dmd-asset-regex").value,
      assetRegexFlags: $("#dmd-asset-regex-flags").value,
      assetMode: $("#dmd-asset-mode").value,
      collectAll: $("#dmd-collect-all").checked
    });
    $("#dmd-action").onchange = () => {
      $("#dmd-overwrite-field").hidden = $("#dmd-action").value !== "overwrite";
    };
    $("#dmd-action").onchange();
    let cleanupBusy = false;
    const setCleanupBusy = (busy, stopId) => {
      cleanupBusy = busy;
      for (const id of ["#dmd-export-conversation", "#dmd-id-import", "#dmd-id-package", "#dmd-forum-load", "#dmd-multi-export", "#dmd-forum-export", "#dmh-refresh", "#dmh-import", "#dmh-clear"]) $(id).disabled = busy;
      $(stopId).disabled = !busy;
    };
    const updatePercentage = (progressId, percentId) => {
      const bar = $(progressId);
      $(percentId).textContent = `${Math.round(bar.value / Math.max(1, bar.max) * 100)}%`;
    };
    const setProgress = (value, max) => {
      max = Math.max(Number(max) || 1, Number(value) || 0, 1);
      const bar = $("#dmd-progress");
      bar.max = max;
      bar.value = Math.min(Number(value) || 0, max);
      $("#dmd-pct").textContent = `${Math.round(bar.value / bar.max * 100)}%`;
    };
    const setMultiProgress = (value, max, status = "") => {
      max = Math.max(Number(max) || 1, 1);
      const bar = $("#dmd-multi-progress");
      bar.max = max;
      bar.value = Math.min(Number(value) || 0, max);
      $("#dmd-multi-pct").textContent = `${Math.round(bar.value / bar.max * 100)}%`;
      $("#dmd-multi-status").textContent = status;
    };
    const automaticFields = /* @__PURE__ */ new Map();
    const fillAutomatic = (id, value) => {
      const field = $(id);
      if (!field.value.trim() || field.value === automaticFields.get(id)) {
        field.value = value;
        automaticFields.set(id, value);
      }
    };
    for (const id of ["#dmd-guild", "#dmd-channel", "#dmd-rx-channel", "#dmd-rx-guild", "#dmd-forum-id"]) {
      $(id).addEventListener("input", () => automaticFields.delete(id));
      $(id).addEventListener("change", () => automaticFields.delete(id));
    }
    const fillContext = () => {
      const ctx = currentContext();
      if (!ctx) return;
      fillAutomatic("#dmd-guild", ctx.guildId);
      fillAutomatic("#dmd-channel", ctx.channelId);
      fillAutomatic("#dmd-rx-channel", ctx.channelId);
      fillAutomatic("#dmd-rx-guild", ctx.guildId);
      void reactionPreviews.refresh("guild");
      if (ctx.guildId !== "@me") fillAutomatic("#dmd-forum-id", ctx.channelId);
      void identityPreviews.refresh("guild");
      void channelPickers.refresh();
    };
    const resolvePreview = createConversationPreviewResolver();
    let detectionVersion = 0;
    const detectVisibleConversation = async () => {
      const channelId = $("#dmd-channel").value.trim(), token = $("#dmd-token").value.trim();
      const version = ++detectionVersion;
      if (panel.style.display !== "flex" || !token || !/^\d{15,22}$/.test(channelId) || cleanupBusy || messageMode === "server") return;
      try {
        const detected = await resolvePreview({ token, channelId });
        if (version !== detectionVersion || cleanupBusy || messageMode === "server" || $("#dmd-channel").value.trim() !== channelId) return;
        messageMode = detected.mode;
        fillAutomatic("#dmd-guild", detected.guildId);
        if (detected.mode === "forums") fillAutomatic("#dmd-forum-id", detected.channelId);
        syncViews();
      } catch (error) {
        if (version === detectionVersion && !cleanupBusy) log("warn", error.message);
      }
    };
    const loadIdentity = async () => {
      const found = await resolveToken($("#dmd-token").value.trim());
      if (!found) {
        log("error", "Could not find a valid Discord authorization token. Refresh Discord and press GET again.");
        return null;
      }
      $("#dmd-token").value = found.token;
      if (!$("#dmd-author").value.trim()) $("#dmd-author").value = found.user.id;
      identityPreviews.seedUser(found.user);
      fillAutomatic("#dmd-rx-author", found.user.id);
      void reactionPreviews.refresh("user");
      void reactionPreviews.refresh("guild");
      void identityPreviews.refresh("user");
      void identityPreviews.refresh("guild");
      void channelPickers.refresh();
      log("success", `Authorization loaded for ${found.user.username || "your account"}.`);
      void detectVisibleConversation();
      return found;
    };
    const queueIdentities = createQueueIdentityResolver();
    let refreshRunningQueue = null;
    const queue = createQueue({ $, log, onChange: () => refreshRunningQueue?.() });
    const { renderQueue } = queue;
    let decoratingQueue = false;
    const decoratedItems = /* @__PURE__ */ new Set();
    const hydrateQueueIcons = async () => {
      const token = $("#dmd-token").value.trim();
      if (!token || decoratingQueue || cleanupBusy) return;
      decoratingQueue = true;
      try {
        for (const item of [...queue.getItems()]) {
          if (cleanupBusy) break;
          const key = `${item.guildId}/${item.channelId}`;
          if (item.icon || item.kind === "ids" || decoratedItems.has(key)) continue;
          decoratedItems.add(key);
          queue.updateIdentity(item, await queueIdentities.resolve(item, token, log));
          await sleep(rand(350, 600));
        }
      } finally {
        decoratingQueue = false;
      }
    };
    const panelWindow = installPanelWindowControls({ panel, dragHandle: panel, resizeHandles: [$("#dmd-resize-left"), $("#dmd-resize-handle")], storage: () => localStorage, storageKey: "del_discord_v1_deleter_geometry_compact", defaultWidth: 660, defaultRatio: 660 / 480 });
    function mountToolbarButton() {
      const toolbar = findDiscordToolbar();
      if (!toolbar) return false;
      if (btn.parentElement !== toolbar) toolbar.appendChild(btn);
      return true;
    }
    btn.onclick = async () => {
      const open = panel.style.display === "flex";
      panel.style.display = open ? "none" : "flex";
      btn.classList.toggle("open", !open);
      if (!open) {
        panelWindow.ensureGeometry();
        fillContext();
        if (!$("#dmd-token").value) await loadIdentity();
        else void detectVisibleConversation();
        if (queue.getItems().length && !cleanupBusy) {
          const continued = await askPopup({
            title: "Saved Queue",
            message: `${queue.getItems().length} queued cleanups are saved locally. Continue running them or clear the queue?`,
            yesText: "Continue",
            noText: "Clear Queue",
            onNo: () => queue.clear()
          });
          if (continued && !cleanupBusy) {
            panel.querySelector('[data-view="multi"]').click();
            await $("#dmd-multi-start").onclick();
          }
        }
      }
    };
    const syncViews = () => {
      const active = panel.querySelector(".dmd-tab.active").dataset.view;
      $("#dmd-messages").style.display = active === "messages" ? "" : "none";
      $("#dmd-reactions").style.display = active === "reactions" ? "" : "none";
      $("#dmd-multi").style.display = active === "multi" ? "" : "none";
      const threadMode = messageMode === "forums" || messageMode === "thread";
      $("#dmd-channel").previousElementSibling.textContent = messageMode === "thread" ? "Thread(s)" : "Channel(s)";
      $("#dmd-channel").placeholder = messageMode === "thread" ? "Thread ID, thread ID" : "Channel ID, channel ID";
      $("#dmd-thread-target").hidden = !threadMode;
      $("#dmd-channel").closest(".dmd-field").hidden = messageMode === "server";
      $("#dmd-archived-option").hidden = messageMode !== "forums";
      if (threadMode && $("#dmd-thread-target-kind").value !== messageMode) {
        $("#dmd-thread-target-kind").value = messageMode;
        $("#dmd-thread-target-kind").dispatchEvent(new Event("change"));
      }
      panel.querySelectorAll("#dmd-message-modes button").forEach((button) => {
        const selected = button.dataset.mode === messageMode || threadMode && button.dataset.mode === "forums";
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
      $("#dmd-forums").style.display = messageMode === "forums" ? "" : "none";
      $("#dmd-messages > .dmd-actions").hidden = messageMode === "forums";
      $("#dmd-queue-conversations").hidden = queueMode === "ids";
      $("#dmd-queue-server-inputs").hidden = queueMode !== "server";
      $("#dmd-ids").style.display = queueMode === "ids" ? "" : "none";
      $("#dmh-panel").style.display = active === "history" ? "flex" : "none";
      $("#dmd-progress-dock").hidden = false;
      const progressView = active === "multi" ? queueMode === "server" ? "multi" : queueMode : active;
      panel.querySelectorAll("[data-progress-view]").forEach((area) => {
        area.hidden = area.dataset.progressView !== progressView;
      });
      void channelPickers.refresh();
    };
    panel.querySelectorAll(".dmd-tab").forEach((tab) => {
      tab.onclick = () => {
        panel.querySelectorAll(".dmd-tab").forEach((x) => x.classList.toggle("active", x === tab));
        syncViews();
        if (tab.dataset.view === "history") history.activate();
        if (tab.dataset.view === "multi") {
          renderQueue();
          void hydrateQueueIcons();
        }
      };
    });
    panel.querySelectorAll("#dmd-message-modes button").forEach((button) => {
      button.onclick = () => {
        messageMode = button.dataset.mode === "forums" ? $("#dmd-thread-target-kind").value : button.dataset.mode;
        void identityPreviews.refresh("guild");
        syncViews();
        savedSettings.save();
      };
    });
    $("#dmd-thread-target-kind").addEventListener("change", () => {
      messageMode = $("#dmd-thread-target-kind").value;
      syncViews();
      savedSettings.save();
    });
    panel.querySelectorAll("#dmd-queue-modes button").forEach((button) => {
      button.onclick = () => {
        queueMode = button.dataset.mode;
        panel.querySelectorAll("#dmd-queue-modes button").forEach((node) => {
          node.classList.toggle("active", node === button);
          node.setAttribute("aria-pressed", String(node === button));
        });
        syncViews();
      };
    });
    syncViews();
    let queuePromptOpen = false, queuePromptDone = null;
    const offerQueue = async (items, options, allowAnyThread = false, targets = null) => {
      if (queuePromptOpen) return;
      if (!items.length && !targets?.length) return log("warn", "Select at least one conversation or message ID.");
      if (items.some((item) => !item.guildId || !/^\d{15,22}$/.test(String(item.kind === "server" ? item.guildId : item.channelId || "")))) return log("error", "Enter valid conversation IDs before adding to the queue.");
      queuePromptOpen = true;
      let finishPrompt;
      queuePromptDone = new Promise((resolve) => {
        finishPrompt = resolve;
      });
      try {
        const approved = await askPopup({
          title: "Add to Queue?",
          message: `Queue this ${options.action || "delete"} cleanup with the selected filters? Starting the queue will run it without another confirmation.`,
          details: targets ? `${targets.length} message IDs` : items.map((item) => item.label || item.channelId).join("\n"),
          yesText: "Add to Queue",
          noText: "Cancel"
        });
        if (!approved) return;
        const savedOptions = { ...options };
        delete savedOptions.textPattern;
        delete savedOptions.assetPattern;
        if (targets) queue.addIdJob(targets, savedOptions);
        else {
          const jobs = [];
          for (const item of items) {
            const decorated = await queueIdentities.resolve(item, $("#dmd-token").value.trim(), log);
            jobs.push({ ...decorated, options: savedOptions, allowAnyThread, detectConversation: item.kind !== "server" });
          }
          queue.addQueueItems(jobs);
        }
        log("info", refreshRunningQueue ? "Cleanup added to the running queue." : "Cleanup queued. Press Start Queue to begin.");
      } finally {
        queuePromptOpen = false;
        finishPrompt();
        queuePromptDone = null;
      }
    };
    const deleteHistoryConversations = async (entries) => {
      if (cleanupBusy) {
        await offerQueue(entries.map((entry) => ({ guildId: "@me", channelId: entry.channelId, label: entry.name || entry.username || entry.channelId })), { action: "delete", collectAll: true, pinnedMode: "any" });
        return [];
      }
      const completed = [];
      setCleanupBusy(true, "#dmh-stop");
      runState.stopped = false;
      $("#dmh-stop").hidden = false;
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.stopped) return completed;
        const approved = await askPopup({
          title: "Are you sure?",
          message: `Delete all of your messages, including pinned messages, in ${entries.length} selected DMs? Other people's messages and the DM conversations will remain.`,
          details: entries.map((entry) => entry.name || entry.username || entry.channelId || entry.userId).join("\n"),
          yesText: "Delete All",
          noText: "Cancel",
          danger: true
        });
        if (!approved || runState.stopped) return completed;
        $("#dmh-progress").max = entries.length;
        $("#dmh-progress").value = 0;
        updatePercentage("#dmh-progress", "#dmh-pct");
        for (const [index, entry] of entries.entries()) {
          if (runState.stopped) break;
          let channelId = entry.channelId;
          if (!channelId && entry.userId) {
            const response = await apiFetch(`${API}/users/@me/channels`, { method: "POST", headers: { Authorization: identity2.token, "Content-Type": "application/json" }, body: JSON.stringify({ recipient_id: entry.userId }) }, log, () => runState.stopped);
            if (!response.ok) throw new Error(`Could not open DM (${response.status}).`);
            channelId = (await response.json()).id;
          }
          if (runState.stopped) break;
          if (!/^\d{15,22}$/.test(String(channelId || ""))) throw new Error("This history entry has no valid DM channel.");
          $("#dmh-progress-status").textContent = `Cleaning ${index + 1}/${entries.length}`;
          const result = await deleteMessages({
            token: identity2.token,
            authorId: identity2.user.id,
            guildId: "@me",
            channelId,
            action: "delete",
            pinnedMode: "any",
            collectAll: true,
            freshHistory: true,
            log,
            stopCheck: () => runState.stopped
          });
          if (!result?.done || result.failed > 0) break;
          completed.push(entry);
          $("#dmh-progress").value = index + 1;
          updatePercentage("#dmh-progress", "#dmh-pct");
        }
        log("info", `Finished ${completed.length}/${entries.length} selected DMs.`);
      } catch (error) {
        log("error", error.message || error);
      } finally {
        setCleanupBusy(false, "#dmh-stop");
        $("#dmh-stop").hidden = true;
        runState.stopped = false;
      }
      return completed;
    };
    $("#dmh-stop").onclick = () => {
      runState.stopped = true;
    };
    $("#dmd-get-token").onclick = loadIdentity;
    $("#dmd-clear").onclick = () => {
      logBox.textContent = "";
      logEntries.length = 0;
      setProgress(0, 1);
    };
    $("#dmd-export-log").onclick = () => {
      if (!logEntries.length) return log("warn", "There is no log to export yet.");
      const ctx = currentContext();
      const header = [
        "Discord deletion log",
        `Exported: ${(/* @__PURE__ */ new Date()).toISOString()}`,
        `Server: ${ctx?.guildId || $("#dmd-guild").value.trim() || ""}`,
        `Channel: ${ctx?.channelId || $("#dmd-channel").value.trim() || ""}`,
        ""
      ].join("\n");
      const body = logEntries.map((x) => `[${x.time}] [${String(x.type).toUpperCase()}] ${x.message}`).join("\n");
      downloadTextFile(`discord-log-${timeStampForFile()}.txt`, header + body);
    };
    let activeExportController = null;
    const exportConversations = async ({ targets, stopId, stopped, setStopped, progress, filename, select = false }) => {
      if (cleanupBusy) return;
      let conversations;
      try {
        conversations = targets();
      } catch (error) {
        return log("error", error.message);
      }
      if (!conversations.length) return log("warn", "Select or queue at least one conversation to export.");
      setCleanupBusy(true, stopId);
      setStopped(false);
      const controller = new AbortController(), { signal } = controller;
      activeExportController = controller;
      try {
        const choice = await askExportSelection(conversations, { range: getRange(conversations[0].channelId), select, signal });
        if (!choice || stopped()) return;
        conversations = choice.conversations;
        const { format, range, downloadAttachments } = choice;
        const identity2 = await resolveToken($("#dmd-token").value.trim(), { log, stopCheck: stopped, strict: true, signal });
        if (stopped()) return;
        if (!identity2) return log("error", "Authorization could not be validated. Refresh Discord and try again.");
        const exports = [], attachmentFiles = [], attachmentReport = [];
        const attachmentState = createAttachmentDownloadState();
        const exportName = `discord-${safeFilePart(filename)}-${timeStampForFile()}`;
        const messageFilename = `${exportName}.${format}`;
        const jsonPrefix = format === "json" && conversations.length > 1 ? `{
  "exportedAt": ${JSON.stringify((/* @__PURE__ */ new Date()).toISOString())},
  "conversationCount": ${conversations.length},
  "conversations": [
` : "";
        const jsonSuffix = jsonPrefix ? "\n  ]\n}" : "";
        const archiveBudget = downloadAttachments ? createZipBudget() : null;
        let exportBytes = jsonPrefix.length + jsonSuffix.length;
        archiveBudget?.setFile(messageFilename, exportBytes);
        archiveBudget?.setFile("attachments.json", 2);
        let messageCount = 0;
        progress(0, conversations.length);
        for (const [index, item] of conversations.entries()) {
          if (stopped()) return;
          const data = await exportConversationData({
            token: identity2.token,
            ...item,
            ...range,
            log,
            stopCheck: stopped,
            signal
          });
          if (stopped()) return;
          const blob2 = await conversationToBlob(data, { format, includeCsvHeader: index === 0, stopCheck: stopped });
          if (stopped()) return;
          const separator = exports.length ? format === "csv" ? "\r\n" : ",\n" : "";
          if (format === "json" || blob2.size) {
            exportBytes += separator.length + blob2.size;
            archiveBudget?.setFile(messageFilename, exportBytes);
          }
          if (downloadAttachments) await collectExportAttachments(data, { files: attachmentFiles, report: attachmentReport, log, stopCheck: stopped, state: attachmentState, signal, budget: archiveBudget });
          if (stopped()) return;
          messageCount += data.messageCount;
          if (format === "json" || blob2.size) {
            if (separator) exports.push(separator);
            exports.push(blob2);
          }
          progress(index + 1, conversations.length);
        }
        const blob = new Blob([jsonPrefix, ...exports, jsonSuffix], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
        if (downloadAttachments) {
          log("info", "Packaging messages and attachments...");
          const reportBlob = new Blob([JSON.stringify(attachmentReport, null, 2)], { type: "application/json" });
          archiveBudget.setFile("attachments.json", reportBlob.size);
          const archive = await filesToZip([
            { name: messageFilename, blob },
            { name: "attachments.json", blob: reportBlob },
            ...attachmentFiles
          ], stopped);
          if (stopped()) return;
          downloadBlob(`${exportName}.zip`, archive);
          const failed = attachmentReport.filter((item) => ["failed", "skipped"].includes(item.status)).length;
          log(failed ? "warn" : "info", `Attachments: ${attachmentFiles.length} downloaded; ${failed} unavailable. See attachments.json in the ZIP.`);
        } else downloadBlob(`${exportName}.${format}`, blob);
        log("success", `Export complete: ${conversations.length} conversations, ${messageCount} messages.`);
      } catch (error) {
        if (!stopped()) log("error", error?.message || error);
      } finally {
        activeExportController = null;
        setCleanupBusy(false, stopId);
        setStopped(false);
      }
    };
    $("#dmd-export-conversation").onclick = () => exportConversations({
      targets: () => {
        const guildId = $("#dmd-guild").value.trim();
        if (!guildId) return [];
        return parseIdList($("#dmd-channel").value, "Channel(s)", { required: true }).map((channelId) => ({ guildId, channelId, label: currentLabel() }));
      },
      stopId: "#dmd-stop",
      stopped: () => runState.stopped,
      setStopped: (value) => {
        runState.stopped = value;
      },
      progress: setProgress,
      filename: `conversation-${currentLabel()}`
    });
    $("#dmd-multi-export").onclick = () => exportConversations({
      targets: () => queue.getItems().filter((item) => !["ids", "server"].includes(item.kind)).map((item) => ({ ...item })),
      stopId: "#dmd-multi-stop",
      stopped: () => runState.multiStopped,
      setStopped: (value) => {
        runState.multiStopped = value;
      },
      progress: (value, max) => setMultiProgress(value, max, `Exported ${value}/${max}`),
      filename: "queue-conversations",
      select: true
    });
    $("#dmd-forum-export").onclick = () => exportConversations({
      targets: () => selectedThreads().map((thread) => ({ guildId: thread.guild_id, channelId: thread.id, label: thread.name || thread.id })),
      stopId: "#dmd-forum-stop",
      stopped: () => runState.stopped,
      setStopped: (value) => {
        runState.stopped = value;
      },
      progress: (value, max) => {
        $("#dmd-progress").max = max;
        $("#dmd-progress").value = value;
        updatePercentage("#dmd-progress", "#dmd-pct");
        $("#dmd-forum-status").textContent = `Exported ${value}/${max}`;
      },
      filename: "forum-conversations"
    });
    $("#dmd-stop").onclick = () => {
      runState.stopped = true;
      activeExportController?.abort();
      log("warn", "Stop requested...");
    };
    $("#dmd-rx-stop").onclick = () => {
      runState.reactionStopped = true;
      log("warn", "Stop requested...");
    };
    for (const side of ["after", "before"]) {
      $(`#dmd-${side}-kind`).onchange = () => {
        const date = $(`#dmd-${side}-kind`).value === "date";
        $(`#dmd-${side}-date-field`).hidden = !date;
        $(`#dmd-${side}-id-field`).hidden = date;
      };
      $(`#dmd-${side}-kind`).onchange();
    }
    const queueMessageTargets = async (requestedChannels = null) => {
      try {
        fillContext();
        if (messageMode === "server") {
          const guildId = $("#dmd-guild").value.trim();
          if (!/^\d{15,22}$/.test(guildId)) throw new Error("Enter a server ID in Server.");
          const guild = await queueIdentities.readGuild(guildId, $("#dmd-token").value.trim(), log);
          return await offerQueue([{ kind: "server", guildId, channelId: `server:${guildId}`, label: guild.name || guildId }], getCleanupOptions(""));
        }
        const context = currentContext();
        const items = (requestedChannels || parseIdList($("#dmd-channel").value, "Channel(s)", { required: true })).map((channelId) => ({
          guildId: $("#dmd-guild").value.trim(),
          channelId,
          label: context?.channelId === channelId ? currentLabel() : channelId,
          thread: messageMode === "thread"
        }));
        return await offerQueue(items, getCleanupOptions(""), messageMode === "thread");
      } catch (error) {
        return log("error", error.message);
      }
    };
    $("#dmd-add-queue").onclick = () => queueMessageTargets();
    $("#dmd-start").onclick = async (_event, requestedChannels = null) => {
      fillContext();
      if (cleanupBusy) return queueMessageTargets(requestedChannels);
      setCleanupBusy(true, "#dmd-stop");
      runState.stopped = false;
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.stopped) return;
        if (messageMode === "server") {
          const guildId = $("#dmd-guild").value.trim();
          if (!/^\d{15,22}$/.test(guildId)) throw new Error("Enter a server ID in Server.");
          await deleteMessages({
            ...getCleanupOptions(""),
            guildId,
            token: identity2.token,
            authorId: identity2.user.id,
            log,
            progress: setProgress,
            stopCheck: () => runState.stopped
          });
          return;
        }
        const channels = requestedChannels || parseIdList($("#dmd-channel").value, "Channel(s)", { required: true });
        const options = channels.map((channelId) => getCleanupOptions(channelId));
        const targets = [];
        for (const channelId of channels) {
          targets.push(await resolveConversation({ token: identity2.token, channelId, log, stopCheck: () => runState.stopped }));
        }
        if (runState.stopped) return;
        const forum = targets.find((target) => target.mode === "forums");
        if (forum) {
          if (targets.length !== 1) throw new Error("Browse one forum at a time to select its threads.");
          messageMode = "forums";
          fillAutomatic("#dmd-forum-id", forum.channelId);
          syncViews();
          $("#dmd-stop").disabled = true;
          $("#dmd-forum-stop").disabled = false;
          await loadForumTargets(identity2, forum.channelId);
          log("info", "Select threads, then press Clean selected threads.");
          return;
        }
        messageMode = targets[0].mode;
        syncViews();
        for (const [index, target] of targets.entries()) {
          if (runState.stopped) break;
          const { channelId, guildId, mode } = target;
          const result = await (mode === "thread" ? cleanupForumThread : deleteMessages)({
            ...options[index],
            allowAnyThread: mode === "thread",
            token: identity2.token,
            authorId: identity2.user.id,
            guildId,
            channelId,
            log,
            progress: setProgress,
            stopCheck: () => runState.stopped
          });
          if (!result?.done || result.failed > 0) break;
        }
      } catch (error) {
        log("error", error?.message || error);
      } finally {
        setCleanupBusy(false, "#dmd-stop");
        $("#dmd-forum-stop").disabled = true;
        runState.stopped = false;
      }
    };
    const singleChannel = () => {
      const channels = parseIdList($("#dmd-channel").value, "Channel(s)");
      return channels.length === 1 ? channels[0] : "";
    };
    const limitedIdTargets = (targets) => {
      if (targets.length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} message IDs per batch. Split larger imports into smaller files.`);
      return targets;
    };
    let idCountTimer;
    const updateIdCount = () => {
      clearTimeout(idCountTimer);
      try {
        const targets = parseMessageIds($("#dmd-id-input").value, singleChannel() || "000000000000000");
        $("#dmd-id-count").textContent = `${targets.length.toLocaleString()} IDs`;
      } catch (error) {
        $("#dmd-id-count").textContent = error.message;
      }
    };
    $("#dmd-id-input").addEventListener("input", () => {
      clearTimeout(idCountTimer);
      idCountTimer = setTimeout(updateIdCount, 150);
    });
    const importIds = async (files) => {
      if (cleanupBusy) return;
      $("#dmd-id-import").disabled = true;
      $("#dmd-id-package").disabled = true;
      try {
        if (!files?.length) return;
        const targets = await importMessageIds(files, singleChannel());
        const input = $("#dmd-id-input");
        const existing = parseMessageIds(input.value, singleChannel() || "000000000000000");
        const keys = new Set(existing.map((target) => `${target.channelId}/${target.messageId}`));
        const additions = targets.filter((target) => !keys.has(`${target.channelId}/${target.messageId}`));
        limitedIdTargets([...existing, ...additions]);
        const appended = additions.map((target) => `https://discord.com/channels/@me/${target.channelId}/${target.messageId}`).join("\n");
        const next = input.value + (input.value && appended ? "\n" : "") + appended;
        parseMessageIds(next, singleChannel() || "000000000000000");
        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        updateIdCount();
        log("success", `Loaded ${targets.length} message IDs locally. No messages were changed.`);
      } catch (error) {
        log("error", error?.message || error);
      } finally {
        $("#dmd-id-import").disabled = cleanupBusy;
        $("#dmd-id-package").disabled = cleanupBusy;
        $("#dmd-id-files").value = "";
        $("#dmd-id-folder").value = "";
      }
    };
    $("#dmd-id-import").onclick = () => $("#dmd-id-files").click();
    $("#dmd-id-package").onclick = () => $("#dmd-id-folder").click();
    $("#dmd-id-files").onchange = (event) => importIds(event.target.files);
    $("#dmd-id-folder").onchange = (event) => importIds(event.target.files);
    $("#dmd-id-clear").onclick = () => {
      $("#dmd-id-input").value = "";
      updateIdCount();
    };
    $("#dmd-id-stop").onclick = () => {
      runState.stopped = true;
      log("warn", "Stop requested...");
    };
    $("#dmd-id-start").onclick = async () => {
      if (cleanupBusy) {
        try {
          const targets = limitedIdTargets(parseMessageIds($("#dmd-id-input").value, singleChannel()));
          return await offerQueue([], getCleanupOptions(""), false, targets);
        } catch (error) {
          return log("error", error.message);
        }
      }
      setCleanupBusy(true, "#dmd-id-stop");
      runState.stopped = false;
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.stopped) return;
        const targets = limitedIdTargets(parseMessageIds($("#dmd-id-input").value, singleChannel()));
        const options = getCleanupOptions("");
        await runDirectMessages({
          ...options,
          token: identity2.token,
          authorId: identity2.user.id,
          targets,
          log,
          stopCheck: () => runState.stopped,
          progress: (value, max, phase) => {
            $("#dmd-id-progress").max = Math.max(1, max);
            $("#dmd-id-progress").value = value;
            updatePercentage("#dmd-id-progress", "#dmd-id-pct");
            $("#dmd-id-status").textContent = `${phase}: ${value}/${max}`;
          }
        });
      } catch (error) {
        log("error", error?.message || error);
      } finally {
        setCleanupBusy(false, "#dmd-id-stop");
        runState.stopped = false;
      }
    };
    $("#dmd-rx-start-kind").onchange = () => {
      const date = $("#dmd-rx-start-kind").value === "date";
      $("#dmd-rx-start-id-field").hidden = date;
      $("#dmd-rx-start-date-field").hidden = !date;
    };
    $("#dmd-rx-go").onclick = async () => {
      if (cleanupBusy) return log("warn", "Wait for the current cleanup to finish before removing reactions.");
      setCleanupBusy(true, "#dmd-rx-stop");
      $("#dmd-rx-go").disabled = true;
      runState.reactionStopped = false;
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.reactionStopped) return;
        fillContext();
        const channels = parseIdList($("#dmd-rx-channel").value.trim() || $("#dmd-channel").value, "Channel(s)", { required: true });
        const limit = Math.max(1, Math.min(MAX_REACTION_SCAN, parseInt($("#dmd-rx-limit").value, 10) || 1e3));
        for (const channelId of channels) {
          if (runState.reactionStopped) break;
          await removeReactions({
            token: identity2.token,
            channelId,
            startId: ($("#dmd-rx-start-kind").value === "date" ? $("#dmd-rx-start-date") : $("#dmd-rx-start")).value.trim(),
            scanLimit: limit,
            reactionAuthorId: $("#dmd-rx-author").value.trim(),
            reactionIds: $("#dmd-rx-filter").value,
            skipOwn: $("#dmd-rx-skipown").checked,
            authorId: identity2.user.id,
            log,
            progress: (v, m, phase) => {
              $("#dmd-rx-progress").max = Math.max(1, m);
              $("#dmd-rx-progress").value = v;
              updatePercentage("#dmd-rx-progress", "#dmd-rx-pct");
              $("#dmd-rx-phase").textContent = `${phase || ""} ${v}/${m}`;
            }
          });
        }
      } catch (error) {
        log("error", error?.message || error);
      } finally {
        setCleanupBusy(false, "#dmd-rx-stop");
        $("#dmd-rx-go").disabled = false;
        runState.reactionStopped = false;
      }
    };
    const addServer = async (guildId) => {
      try {
        if (!/^\d{15,22}$/.test(guildId || "")) throw new Error("Enter a valid Server ID or open a server channel.");
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2) return;
        const guild = await queueIdentities.readGuild(guildId, identity2.token, log);
        $("#dmd-server-id").value = guildId;
        queueServerPreview.seedGuild(guild);
        void queueServerPreview.refresh("guild");
        await offerQueue([{ kind: "server", guildId, channelId: `server:${guildId}`, label: guild.name || `Server ${guildId}` }], getCleanupOptions(""));
      } catch (error) {
        log("error", error.message);
      }
    };
    $("#dmd-server-add").onclick = () => addServer($("#dmd-server-id").value.trim());
    $("#dmd-server-current").onclick = () => addServer(currentContext()?.guildId);
    $("#dmd-multi-clear").onclick = async () => {
      if (queue.getItems().length) {
        const approved = await askPopup({ title: "Clear queue?", message: `Remove all ${queue.getItems().length} queued conversations?`, yesText: "Clear", noText: "Cancel", danger: true });
        if (!approved) return;
      }
      queue.clear();
      setMultiProgress(0, 1, "");
    };
    $("#dmd-multi-stop").onclick = () => {
      runState.multiStopped = true;
      activeExportController?.abort();
      log("warn", "Stopping queue...");
    };
    $("#dmd-multi-start").onclick = async () => {
      if (cleanupBusy) return log("info", "The queue will continue automatically as jobs are added.");
      if (!queue.getItems().length) return log("error", "The queue is empty.");
      setCleanupBusy(true, "#dmd-multi-stop");
      runState.multiStopped = false;
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.multiStopped) return;
        const options = getCleanupOptions("");
        let completed = 0, activeItem = null;
        refreshRunningQueue = () => {
          const total = completed + queue.getItems().length;
          setMultiProgress(completed, total, activeItem ? `Running ${completed + 1}/${total}: ${cleanQueueLabel(activeItem.label) || activeItem.channelId}` : `Finished ${completed}/${total}`);
        };
        refreshRunningQueue();
        while (queue.getItems().length || queuePromptOpen) {
          if (runState.multiStopped) break;
          if (!queue.getItems().length) {
            await queuePromptDone;
            continue;
          }
          const item = { ...queue.getItems()[0] };
          activeItem = item;
          refreshRunningQueue();
          const itemOptions = item.options ? normalizeCleanupOptions(item.options) : options;
          let detected;
          if (item.detectConversation && item.kind !== "ids") {
            detected = await resolveConversation({ token: identity2.token, channelId: item.channelId, log, stopCheck: () => runState.multiStopped });
            if (detected.mode === "forums") throw new Error("Open this forum in Messages and select its threads before queuing cleanup.");
          }
          const result = await (item.kind === "ids" ? runDirectMessages : (detected ? detected.mode === "thread" : item.thread) ? cleanupForumThread : deleteMessages)({
            ...itemOptions,
            freshHistory: true,
            token: identity2.token,
            authorId: identity2.user.id,
            guildId: detected?.guildId || item.guildId,
            channelId: ["ids", "server"].includes(item.kind) ? void 0 : item.channelId,
            targets: item.targets,
            allowAnyThread: detected ? detected.mode === "thread" : item.allowAnyThread,
            skipConfirm: true,
            log,
            stopCheck: () => runState.multiStopped
          });
          if (result?.unauthorized) {
            runState.multiStopped = true;
            break;
          }
          if (result?.cancelled || result?.stopped || result?.stalled || result?.httpStatus) {
            runState.multiStopped = true;
            break;
          }
          if (!result?.done || result.failed > 0) {
            runState.multiStopped = true;
            break;
          }
          completed++;
          activeItem = null;
          queue.completeItem(item);
          refreshRunningQueue();
          if (queue.getItems().length && !runState.multiStopped) await sleep(rand(1400, 2400));
        }
        log(runState.multiStopped ? "warn" : "success", runState.multiStopped ? "Queue stopped." : `Finished all ${completed} queued items.`);
      } catch (error) {
        log("error", error?.message || error);
      } finally {
        refreshRunningQueue = null;
        setCleanupBusy(false, "#dmd-multi-stop");
        runState.multiStopped = false;
      }
    };
    const forumTargetValue = () => {
      const forum = $("#dmd-forum-id").value.trim();
      return forum && forum !== automaticFields.get("#dmd-forum-id") ? forum : $("#dmd-channel").value.trim() || forum;
    };
    let forumThreads = [];
    let forumThreadsById = /* @__PURE__ */ new Map();
    const selectedThreads = () => [...$("#dmd-forum-list").selectedOptions].map((option) => forumThreadsById.get(option.value)).filter(Boolean);
    const loadForumTargets = async (identity2, forumId) => {
      forumThreads = [];
      forumThreadsById.clear();
      $("#dmd-forum-list").textContent = "";
      forumThreads = await listForumThreads({
        token: identity2.token,
        forumId,
        includeArchived: $("#dmd-forum-archived").checked,
        log,
        stopCheck: () => runState.stopped
      });
      forumThreadsById = new Map(forumThreads.map((thread) => [thread.id, thread]));
      const fragment = document.createDocumentFragment();
      for (const thread of forumThreads) {
        const option = document.createElement("option");
        option.value = thread.id;
        option.textContent = `${thread.name || thread.id}${thread.thread_metadata?.archived ? " \xB7 archived" : ""}${thread.thread_metadata?.locked ? " \xB7 locked" : ""}`;
        fragment.appendChild(option);
      }
      $("#dmd-forum-list").appendChild(fragment);
      $("#dmd-forum-status").textContent = `${forumThreads.length} threads loaded`;
    };
    $("#dmd-forum-stop").onclick = () => {
      runState.stopped = true;
      activeExportController?.abort();
      log("warn", "Stop requested...");
    };
    $("#dmd-forum-load").onclick = async () => {
      if (cleanupBusy) return;
      setCleanupBusy(true, "#dmd-forum-stop");
      runState.stopped = false;
      forumThreads = [];
      forumThreadsById.clear();
      $("#dmd-forum-list").textContent = "";
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.stopped) return;
        fillContext();
        const forumId = forumTargetValue();
        const target = await resolveConversation({ token: identity2.token, channelId: forumId, log, stopCheck: () => runState.stopped });
        messageMode = target.mode;
        syncViews();
        if (target.mode !== "forums") {
          if ($("#dmd-channel").value.trim() !== target.channelId && $("#dmd-channel").value.trim() && $("#dmd-channel").value !== automaticFields.get("#dmd-channel")) {
            log("warn", "The forum field targets a different conversation. Update Channel(s) to use this target.");
            return;
          }
          fillAutomatic("#dmd-channel", target.channelId);
          log("info", "Conversation detected. Press Start to preview its matching messages.");
          return;
        }
        await loadForumTargets(identity2, target.channelId);
      } catch (error) {
        $("#dmd-forum-status").textContent = "No thread list loaded";
        log("error", error?.message || error);
      } finally {
        setCleanupBusy(false, "#dmd-forum-stop");
        runState.stopped = false;
      }
    };
    $("#dmd-forum-queue").onclick = async () => {
      const threads = selectedThreads();
      if (!threads.length) return log("warn", "Select at least one forum thread.");
      try {
        await offerQueue(threads.map((thread) => ({ guildId: thread.guild_id, channelId: thread.id, label: `Thread: ${thread.name || thread.id}`, thread: true })), getCleanupOptions(""), true);
      } catch (error) {
        log("error", error.message);
      }
    };
    $("#dmd-forum-run").onclick = async () => {
      if (cleanupBusy && !selectedThreads().length) {
        try {
          fillContext();
          return await $("#dmd-start").onclick(null, parseIdList(forumTargetValue(), "Conversation IDs", { required: true }));
        } catch (error) {
          return log("error", error.message);
        }
      }
      if (cleanupBusy) {
        try {
          return await offerQueue(selectedThreads().map((thread) => ({ guildId: thread.guild_id, channelId: thread.id, label: `Thread: ${thread.name || thread.id}`, thread: true })), getCleanupOptions(""));
        } catch (error) {
          return log("error", error.message);
        }
      }
      const threads = selectedThreads();
      if (!threads.length) {
        try {
          fillContext();
          const targetIds = forumTargetValue();
          return await $("#dmd-start").onclick(null, targetIds ? parseIdList(targetIds, "Conversation IDs", { required: true }) : null);
        } catch (error) {
          return log("error", error.message);
        }
      }
      setCleanupBusy(true, "#dmd-forum-stop");
      runState.stopped = false;
      try {
        const identity2 = await resolveToken($("#dmd-token").value.trim()) || await loadIdentity();
        if (!identity2 || runState.stopped) return;
        const options = getCleanupOptions("");
        $("#dmd-progress").max = threads.length;
        $("#dmd-progress").value = 0;
        updatePercentage("#dmd-progress", "#dmd-pct");
        for (const [index, thread] of threads.entries()) {
          if (runState.stopped) break;
          $("#dmd-forum-status").textContent = `${index + 1}/${threads.length}: ${thread.name || thread.id}`;
          const result = await cleanupForumThread({
            ...options,
            guildId: thread.guild_id,
            channelId: thread.id,
            token: identity2.token,
            authorId: identity2.user.id,
            log,
            stopCheck: () => runState.stopped
          });
          if (result.unauthorized || result.cancelled || result.stopped) break;
          $("#dmd-progress").value = index + 1;
          updatePercentage("#dmd-progress", "#dmd-pct");
        }
      } catch (error) {
        log("error", error?.message || error);
      } finally {
        setCleanupBusy(false, "#dmd-forum-stop");
        runState.stopped = false;
      }
    };
    let lastUrl = location.href;
    let mountQueued = false;
    const toolbarButtonHealthy = () => btn.isConnected && btn.parentElement?.isConnected && btn.offsetParent !== null;
    const scheduleMount = () => {
      if (mountQueued) return;
      mountQueued = true;
      requestAnimationFrame(() => {
        mountQueued = false;
        if (!toolbarButtonHealthy()) mountToolbarButton();
      });
    };
    const handleRouteChange = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      fillContext();
      void detectVisibleConversation();
    };
    observeDiscordPage(() => {
      handleRouteChange();
      if (!toolbarButtonHealthy()) scheduleMount();
    });
    window.addEventListener("popstate", handleRouteChange, { passive: true });
    window.addEventListener("hashchange", handleRouteChange, { passive: true });
    mountToolbarButton();
    fillContext();
  }

  // src/index.js
  function init() {
    initDeleter();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
