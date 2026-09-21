import type { Position } from "../../types/components/dubbedButton";
import type { DubbedMenuProps } from "../../types/components/dubbedMenu";
import UI from "../../ui";
import {
  createDomId,
  setInteractiveHiddenState,
  UIComponent,
} from "./componentShared";

export default class DubbedMenu extends UIComponent {
  contentWrapper: HTMLElement;
  headerContainer: HTMLElement;
  bodyContainer: HTMLElement;
  footerContainer: HTMLElement;
  titleContainer: HTMLElement;
  title: HTMLElement;

  private _position: Position;
  private _titleHtml: string;

  // A11y: stable ids for aria-controls / aria-labelledby.
  private readonly menuId = createDomId("dubbed-menu");
  private readonly titleId = createDomId("dubbed-menu-title");

  constructor({ position = "default", titleHtml = "" }: DubbedMenuProps) {
    super();
    this._position = position;
    this._titleHtml = titleHtml;

    const {
      container,
      contentWrapper,
      headerContainer,
      bodyContainer,
      footerContainer,
      titleContainer,
      title,
    } = this.createElements();
    this.container = container;
    this.contentWrapper = contentWrapper;
    this.headerContainer = headerContainer;
    this.bodyContainer = bodyContainer;
    this.footerContainer = footerContainer;
    this.titleContainer = titleContainer;
    this.title = title;
  }

  protected createElements() {
    const container = UI.createEl("dubbed-block", ["dubbed-menu"]);
    container.hidden = true;
    container.id = this.menuId;
    container.dataset.position = this._position;

    // Treat the quick settings menu as a non-modal dialog/popover.
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-modal", "false");
    setInteractiveHiddenState(container, true);

    const contentWrapper = UI.createEl("dubbed-block", [
      "dubbed-menu-content-wrapper",
    ]);
    container.appendChild(contentWrapper);

    // header
    const headerContainer = UI.createEl("dubbed-block", [
      "dubbed-menu-header-container",
    ]);
    const titleContainer = UI.createEl("dubbed-block", [
      "dubbed-menu-title-container",
    ]);
    headerContainer.appendChild(titleContainer);
    const title = UI.createEl("dubbed-block", ["dubbed-menu-title"]);
    title.id = this.titleId;
    title.append(this._titleHtml);
    titleContainer.appendChild(title);

    container.setAttribute("aria-labelledby", this.titleId);

    // body & footer
    const bodyContainer = UI.createEl("dubbed-block", ["dubbed-menu-body-container"]);
    const footerContainer = UI.createEl("dubbed-block", [
      "dubbed-menu-footer-container",
    ]);

    contentWrapper.append(headerContainer, bodyContainer, footerContainer);
    return {
      container,
      contentWrapper,
      headerContainer,
      bodyContainer,
      footerContainer,
      titleContainer,
      title,
    };
  }

  setText(titleText: string) {
    this._titleHtml = this.title.textContent = titleText;
    return this;
  }

  remove() {
    this.container.remove();
    return this;
  }

  override set hidden(isHidden: boolean) {
    setInteractiveHiddenState(this.container, isHidden);
  }

  override get hidden() {
    return super.hidden;
  }

  get position() {
    return this._position;
  }

  set position(position: Position) {
    this._position = this.container.dataset.position = position;
  }
}
