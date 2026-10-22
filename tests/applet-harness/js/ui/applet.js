// Minimal Cinnamon applet base used by the applet test harness.
const PopupMenu = imports.ui.popupMenu;

var AllowedLayout = { HORIZONTAL: 1, VERTICAL: 2, BOTH: 3 };

var Applet = class Applet {
    _init(orientation, panelHeight, instanceId) {
        this._orientation = orientation;
        this._panelHeight = panelHeight;
        this._instanceId = instanceId;
        this.icons = [];
        this.labels = [];
        this.tooltips = [];
    }
    setAllowedLayout(layout) {
        this._allowedLayout = layout;
    }
    set_applet_icon_name(name) {
        this.icons.push(name);
    }
    set_applet_tooltip(text) {
        this.tooltips.push(text);
    }
    set_applet_label(text) {
        this.labels.push(text);
    }
    setMenu(menu) {
        this._applet_context_menu = menu;
    }
};

var IconApplet = class IconApplet extends Applet {};

var TextIconApplet = class TextIconApplet extends IconApplet {};

var AppletPopupMenu = class AppletPopupMenu extends PopupMenu.PopupMenu {};

function main(metadata, orientation, panelHeight, instanceId) {
    return new TextIconApplet(orientation, panelHeight, instanceId);
}
