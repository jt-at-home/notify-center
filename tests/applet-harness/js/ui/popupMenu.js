// Minimal popup menu implementation for the applet test harness.
var PopupMenu = class PopupMenu {
    constructor(owner, orientation) {
        this.owner = owner;
        this.orientation = orientation;
        this.items = [];
        this.handlers = {};
        this.isOpen = false;
        this.destroyed = false;
    }
    addMenuItem(item) {
        this.items.push(item);
        return item;
    }
    connect(signal, callback) {
        if (!this.handlers[signal]) {
            this.handlers[signal] = [];
        }
        this.handlers[signal].push(callback);
        return this.handlers[signal].length;
    }
    emit(signal, ...args) {
        const handlers = this.handlers[signal] || [];
        for (const handler of handlers) {
            handler(this, ...args);
        }
    }
    toggle() {
        this.isOpen = !this.isOpen;
        this.emit("open-state-changed", this.isOpen);
    }
    destroy() {
        this.destroyed = true;
    }
};

var PopupMenuItem = class PopupMenuItem {
    constructor(text) {
        this.text = text || "";
        this.label = {
            text: this.text,
            set_text: (value) => {
                this.label.text = value;
            },
        };
        this.actor = { reactive: true, can_focus: true };
        this.handlers = {};
    }
    setLabel(text) {
        this.label.text = text;
    }
    connect(signal, callback) {
        if (!this.handlers[signal]) {
            this.handlers[signal] = [];
        }
        this.handlers[signal].push(callback);
        return this.handlers[signal].length;
    }
    activate() {
        const handlers = this.handlers["activate"] || [];
        for (const handler of handlers) {
            handler(this);
        }
    }
};

var PopupSeparatorMenuItem = class PopupSeparatorMenuItem extends PopupMenuItem {
    constructor() {
        super("-");
    }
};

var PopupMenuManager = class PopupMenuManager {
    constructor(owner) {
        this.owner = owner;
        this.menus = [];
    }
    addMenu(menu) {
        this.menus.push(menu);
    }
    removeMenu(menu) {
        const index = this.menus.indexOf(menu);
        if (index !== -1) {
            this.menus.splice(index, 1);
        }
    }
};
