const MAX_HISTORY_ITEMS = 20;

class HistoryManager {
    constructor() {
        this.history = [];
        this.storageKey = 'nanobanana_prompt_history';
    }

    async load() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                this.history = JSON.parse(stored);
            }
        } catch (e) {
            console.warn("Failed to load history:", e);
            this.history = [];
        }
        return this.history;
    }

    async save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.history));
        } catch (e) {
            console.error("Failed to save history:", e);
        }
    }

    getAll() {
        // Return reverse chronological order (newest first)
        return this.history.slice().reverse();
    }

    add(entry) {
        // entry expected to have: prompt, model, presets[], settings{}, timestamp
        const item = {
            id: 'hist-' + Date.now().toString(36) + Math.random().toString(36).substr(2),
            timestamp: Date.now(),
            ...entry
        };

        // Add to end
        this.history.push(item);

        // Trim to max size (remove from start/oldest)
        if (this.history.length > MAX_HISTORY_ITEMS) {
            this.history = this.history.slice(this.history.length - MAX_HISTORY_ITEMS);
        }

        this.save();
        return item;
    }

    delete(id) {
        const index = this.history.findIndex(h => h.id === id);
        if (index !== -1) {
            this.history.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }

    clear() {
        this.history = [];
        this.save();
    }
}

module.exports = new HistoryManager();
