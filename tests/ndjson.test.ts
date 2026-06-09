// tests/ndjson.test.ts
import { test, expect } from "bun:test";
import { parseNdjsonMessages } from "../src/ndjson";

// ─── string content ───────────────────────────────────────────────────────────

test("parses user message with string content", () => {
  const line = JSON.stringify({ type: "user", content: "Hello there" });
  expect(parseNdjsonMessages(line)).toEqual(["Hello there"]);
});

test("parses user message with message.content string", () => {
  const line = JSON.stringify({ type: "user", message: { role: "user", content: "Hi from message" } });
  expect(parseNdjsonMessages(line)).toEqual(["Hi from message"]);
});

// ─── array content ────────────────────────────────────────────────────────────

test("parses user message with array content of text blocks", () => {
  const line = JSON.stringify({
    type: "user",
    content: [
      { type: "text", text: "First part " },
      { type: "text", text: "second part" },
    ],
  });
  expect(parseNdjsonMessages(line)).toEqual(["First part second part"]);
});

test("parses user message with message.content array", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Array via message" },
      ],
    },
  });
  expect(parseNdjsonMessages(line)).toEqual(["Array via message"]);
});

test("array content: non-text blocks are skipped, text blocks concatenated", () => {
  const line = JSON.stringify({
    type: "user",
    content: [
      { type: "image", source: "..." },
      { type: "text", text: "Only text" },
    ],
  });
  expect(parseNdjsonMessages(line)).toEqual(["Only text"]);
});

// ─── skip non-user lines ─────────────────────────────────────────────────────

test("skips assistant lines", () => {
  const line = JSON.stringify({ type: "assistant", content: "I am the AI" });
  expect(parseNdjsonMessages(line)).toEqual([]);
});

test("skips system lines", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });
  expect(parseNdjsonMessages(line)).toEqual([]);
});

test("skips result lines", () => {
  const line = JSON.stringify({ type: "result", subtype: "success" });
  expect(parseNdjsonMessages(line)).toEqual([]);
});

test("skips unparseable lines", () => {
  expect(parseNdjsonMessages("not-json-at-all")).toEqual([]);
  expect(parseNdjsonMessages("{broken json")).toEqual([]);
});

test("skips empty lines", () => {
  expect(parseNdjsonMessages("")).toEqual([]);
  expect(parseNdjsonMessages("   ")).toEqual([]);
});

// ─── multiple lines ───────────────────────────────────────────────────────────

test("multiple user lines returns messages in order", () => {
  const lines = [
    JSON.stringify({ type: "user", content: "First message" }),
    JSON.stringify({ type: "user", content: "Second message" }),
  ].join("\n");
  expect(parseNdjsonMessages(lines)).toEqual(["First message", "Second message"]);
});

test("mixed user and non-user lines: only user messages extracted", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "user", content: "Hello" }),
    JSON.stringify({ type: "assistant", content: "Hi" }),
    JSON.stringify({ type: "user", content: "World" }),
  ].join("\n");
  expect(parseNdjsonMessages(lines)).toEqual(["Hello", "World"]);
});

test("trailing newline is handled gracefully", () => {
  const text = JSON.stringify({ type: "user", content: "msg" }) + "\n";
  expect(parseNdjsonMessages(text)).toEqual(["msg"]);
});

test("windows CRLF line endings handled", () => {
  const lines = JSON.stringify({ type: "user", content: "A" }) + "\r\n" +
                JSON.stringify({ type: "user", content: "B" }) + "\r\n";
  expect(parseNdjsonMessages(lines)).toEqual(["A", "B"]);
});

// ─── edge cases ───────────────────────────────────────────────────────────────

test("user message with empty string content returns empty string", () => {
  const line = JSON.stringify({ type: "user", content: "" });
  expect(parseNdjsonMessages(line)).toEqual([""]);
});

test("user message with no content field is skipped", () => {
  const line = JSON.stringify({ type: "user" });
  expect(parseNdjsonMessages(line)).toEqual([]);
});
