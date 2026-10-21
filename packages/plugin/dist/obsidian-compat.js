"use strict";
/**
 * Obsidian API shims that keep one behaviour across every Obsidian version
 * Gryphon supports (manifest minAppVersion → today) without calling APIs
 * Obsidian has deprecated.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.warningButton = warningButton;
exports.noticeWithElement = noticeWithElement;
const obsidian_1 = require("obsidian");
/**
 * Style a button the way ButtonComponent.setWarning() does, without the
 * deprecated call. Since 1.13 Obsidian defines setWarning() as
 * setDestructive().setCta(); before that it added the mod-warning class.
 */
function warningButton(btn) {
    if ((0, obsidian_1.requireApiVersion)("1.13.0"))
        return btn.setDestructive().setCta();
    btn.buttonEl.addClass("mod-warning");
    return btn;
}
/**
 * A Notice plus the element its message is rendered into — the element the
 * deprecated `noticeEl` property returned (since 1.8.7 it is the same element
 * as `messageEl`). The message is passed as a fragment holding one text node;
 * after construction that node's parent is that element, on every version.
 * `el` is null only if the host's Notice didn't render the message (tests).
 */
function noticeWithElement(message, duration) {
    const text = activeDocument.createTextNode(message);
    const fragment = activeWindow.createFragment();
    fragment.appendChild(text);
    const notice = new obsidian_1.Notice(fragment, duration);
    return { notice, el: text.parentElement };
}
