/**
 * Obsidian API shims that keep one behaviour across every Obsidian version
 * Gryphon supports (manifest minAppVersion → today) without calling APIs
 * Obsidian has deprecated.
 */

import { Notice, requireApiVersion } from "obsidian";
import type { ButtonComponent } from "obsidian";

/**
 * Style a button the way ButtonComponent.setWarning() does, without the
 * deprecated call. Since 1.13 Obsidian defines setWarning() as
 * setDestructive().setCta(); before that it added the mod-warning class.
 */
export function warningButton(btn: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) return btn.setDestructive().setCta();
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
export function noticeWithElement(message: string, duration?: number): { notice: Notice; el: HTMLElement | null } {
  const text = activeDocument.createTextNode(message);
  const fragment = activeWindow.createFragment();
  fragment.appendChild(text);
  const notice = new Notice(fragment, duration);
  return { notice, el: text.parentElement };
}
