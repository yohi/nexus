import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { Navigation } from "../../src/components/navigation.js";

describe("Navigation", () => {
  afterEach(() => cleanup());

  it("renders five tabs and highlights the active one", () => {
    const { getByText } = render(<Navigation activeIndex={0} onChange={vi.fn()} />);
    expect(getByText("1 Overview")).toBeDefined();
    expect(getByText("5 Diagnostics")).toBeDefined();
  });
});
