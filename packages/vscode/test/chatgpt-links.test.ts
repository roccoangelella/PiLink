import assert from "node:assert/strict";
import test from "node:test";
import { chatGptNavigation, chatGptUrl, isAllowedChatGptUrl } from "../src/chatgpt-links.js";

test("ChatGPT navigation is restricted to official HTTPS pages", () => {
  assert.equal(chatGptUrl("security"), "https://chatgpt.com/#settings/Security");
  assert.equal(chatGptUrl("plugins"), "https://chatgpt.com/plugins");
  assert.equal(chatGptUrl("work"), "https://chatgpt.com/?surface=work");
  assert.equal(isAllowedChatGptUrl("https://chatgpt.com/#settings/Security"), true);
  assert.equal(isAllowedChatGptUrl("https://chatgpt.com/plugins"), true);
  assert.equal(isAllowedChatGptUrl("https://chatgpt.com/?surface=work"), true);
  for (const value of [
    "http://chatgpt.com/plugins",
    "https://chatgpt.com.evil.test/plugins",
    "https://user:password@chatgpt.com/plugins",
    "https://evil.test/",
  ]) assert.equal(isAllowedChatGptUrl(value), false, value);
});

test("ChatGPT Work gets a dedicated Integrated Browser editor", () => {
  assert.deepEqual(chatGptNavigation("work"), {
    url: "https://chatgpt.com/?surface=work",
  });
  assert.deepEqual(chatGptNavigation("security"), {
    url: "https://chatgpt.com/#settings/Security",
    reuseUrlFilter: "https://chatgpt.com/**",
  });
  assert.deepEqual(chatGptNavigation("plugins"), {
    url: "https://chatgpt.com/plugins",
    reuseUrlFilter: "https://chatgpt.com/**",
  });
  assert.match(chatGptNavigation("work").url, /surface=work/u);
});
