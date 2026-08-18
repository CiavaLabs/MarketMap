export class PopoverController {
  constructor(trigger, panel, lifecycle, options = {}) {
    this.trigger = trigger;
    this.panel = panel;
    this.lifecycle = lifecycle;
    this.document = options.document || trigger?.ownerDocument || globalThis.document;
    this.isOpen = false;
    if (!trigger || !panel || !lifecycle) return;

    this.lifecycle.listen(trigger, "click", (event) => {
      event.preventDefault();
      this.toggle();
    });
    this.lifecycle.listen(this.document, "keydown", (event) => {
      if (event.key === "Escape" && this.isOpen) this.close({ restoreFocus: true });
    });
    this.lifecycle.listen(this.document, "click", (event) => {
      if (!this.isOpen) return;
      const target = event.target;
      if (target === trigger || trigger.contains(target) || panel.contains(target)) return;
      this.close();
    });
  }

  toggle() {
    if (this.isOpen) this.close({ restoreFocus: true });
    else this.open();
  }

  open() {
    if (!this.panel || this.isOpen) return;
    this.isOpen = true;
    this.panel.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
  }

  close({ restoreFocus = false } = {}) {
    if (!this.panel || !this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.trigger.focus();
  }
}
