// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingNavigation } from "./RecordingNavigation";

const total = 26 * 3600;
const offsets = Array.from({ length: 1561 }, (_, index) => index * 60);
const initialProps = {
  baseTimestamp: "2026-10-30_18-00-00", total, position: 0, seekTarget: { time: 0 }, offsets,
  durations: offsets.slice(1).map(() => 60), completed: offsets.slice(1).map(() => false),
  trigger: null, loading: false, estimated: true, footageEnd: null, onSeek: vi.fn(),
};

describe("recording navigation interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: typeof initialProps;
  const render = () => act(() => root.render(<RecordingNavigation {...props} />));
  const button = (name: string) => [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === name || button.textContent === name)!;
  const click = (name: string) => act(() => button(name).click());
  const slider = () => container.querySelector<HTMLDivElement>('[aria-label="Recording position"]')!;
  const overview = () => container.querySelector<HTMLInputElement>('[aria-label="Timeline window position"]')!;
  const pointer = (type: string, clientX: number) => act(() => slider().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX })));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = { ...initialProps, onSeek: vi.fn() };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000 } as DOMRect);
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Element.prototype, "setPointerCapture");
    Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
  });

  it("previews a drag and issues exactly one seek when released", () => {
    pointer("pointerdown", 100);
    pointer("pointermove", 200);
    pointer("pointermove", 700);
    expect(props.onSeek).not.toHaveBeenCalled();
    expect(slider().getAttribute("aria-valuenow")).toBe("630");
    pointer("pointerup", 800);
    expect(props.onSeek).toHaveBeenCalledExactlyOnceWith(720);
  });

  it("cancels an interrupted drag without loading its preview", () => {
    pointer("pointerdown", 300);
    pointer("pointercancel", 300);
    expect(props.onSeek).not.toHaveBeenCalled();
    expect(slider().getAttribute("aria-valuenow")).toBe("0");
  });

  it("keeps manual panning stable as playback advances and follows explicit seeks", () => {
    click("Later timeline window");
    expect(overview().value).toBe("1350");
    expect(button("Follow playhead").getAttribute("aria-pressed")).toBe("false");
    props = { ...props, position: 10 };
    render();
    expect(overview().value).toBe("1350");
    props = { ...props, position: 40_000, seekTarget: { time: 40_000 } };
    render();
    expect(overview().value).toBe("40000");
    expect(button("Follow playhead").getAttribute("aria-pressed")).toBe("true");
  });

  it("reveals a repeated explicit seek after manually browsing elsewhere", () => {
    click("Later timeline window");
    props = { ...props, seekTarget: { time: 0 } };
    render();
    expect(overview().value).toBe("450");
    expect(button("Follow playhead").getAttribute("aria-pressed")).toBe("true");
  });

  it("jumps into the second recorded day without applying the browser timezone", () => {
    click("Jump to time");
    const input = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    input.value = "2026-10-31T13:42:15";
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onSeek).toHaveBeenCalledExactlyOnceWith(70_935);
    input.value = "2026-11-03T13:42:15";
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("within this recording");
    expect(props.onSeek).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected window valid when measured duration becomes shorter", () => {
    props = { ...props, total: 910 };
    render();
    expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe("900");
    props = { ...props, total: 880 };
    render();
    expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe("all");
    expect(overview()).toBeNull();
  });

  it("supports precise and whole-window keyboard seeks without bubbling", () => {
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    try {
      act(() => slider().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
      expect(props.onSeek).toHaveBeenLastCalledWith(5);
      expect(outer).not.toHaveBeenCalled();
      act(() => slider().dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true })));
      expect(props.onSeek).toHaveBeenLastCalledWith(900);
      act(() => slider().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
      expect(props.onSeek).toHaveBeenLastCalledWith(total);
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });
});
