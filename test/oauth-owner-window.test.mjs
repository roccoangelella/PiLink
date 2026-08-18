import assert from "node:assert/strict";
import test from "node:test";

import {
  closeOwnerRegistrationWindow,
  createOwnerPairing,
  isOwnerRegistrationWindowOpen,
} from "../dist/oauth-owner.js";

test("the local owner can close the temporary DCR registration window immediately", () => {
  createOwnerPairing("https://mcp.example.test");
  assert.equal(isOwnerRegistrationWindowOpen(), true);
  closeOwnerRegistrationWindow();
  assert.equal(isOwnerRegistrationWindowOpen(), false);
});
