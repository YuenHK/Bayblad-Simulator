import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AdminLogin } from "./AdminLogin";
import { AdminDashboard } from "./AdminDashboard";
it("asks for only a phrase and posts the shared login payload", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, {status:204}));
  const success = vi.fn(async () => undefined);
  render(<AdminLogin fetcher={fetcher} onSuccess={success} />);
  expect(screen.queryByLabelText("帳號")).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("口令"), "admin");
  await userEvent.click(screen.getByRole("button",{name:"進入控制台"}));
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({passphrase:"admin"});
});
it("shows one of four sections at a time and no password or deletion controls", async () => {
  const fetcher = async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("rooms") ? {rooms:[],paused:false} : {rows:[],total:0,page:1,pageSize:25}),{headers:{"Content-Type":"application/json"}});
  render(<AdminDashboard fetcher={fetcher} session={{username:"共用控制台",expiresAt:"2026-10-01T00:00:00Z",csrfToken:"csrf"}} onUnauthorized={()=>undefined} />);
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  expect(screen.getByLabelText("班別").closest("details")).not.toHaveAttribute("open");
  expect(screen.queryByRole("button",{name:"更改密碼"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"刪除紀錄"})).not.toBeInTheDocument();
  expect(screen.queryByRole("heading",{name:"對戰紀錄"})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab",{name:"對戰紀錄"}));
  expect(screen.getByRole("heading",{name:"對戰紀錄"})).toBeInTheDocument();
  expect(screen.queryByRole("heading",{name:"歷史紀錄中的高分設計"})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab",{name:"高分設計"}));
  expect(screen.getByRole("heading",{name:"歷史紀錄中的高分設計"})).toBeInTheDocument();
});
