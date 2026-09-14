import assert from "node:assert/strict";
import test from "node:test";
import { prepareComputerControlLaunch } from "../dist/terminal-launcher.js";

test("computer-control launch flag is stripped and converted to transient child policy", () => {
  const prepared = prepareComputerControlLaunch(
    ["start", "--mode", "single", "--allow-computer-control"],
    {},
  );
  assert.deepEqual(prepared.argv, ["start", "--mode", "single"]);
  assert.equal(prepared.computerControl, true);
  assert.equal(prepared.env.PI_COMPUTER_CONTROL, "true");
  assert.equal(prepared.env.PI_COMPUTER_CONTROL_CLIENT_IDS, "*");
});

test("computer-control launch pins an unspecified start to Single agent mode", () => {
  const prepared = prepareComputerControlLaunch(["start", "--allow-computer-control"], {});
  assert.deepEqual(prepared.argv, ["start", "--mode", "single"]);
});

test("computer-control launch preserves an explicit OAuth client allowlist", () => {
  const prepared = prepareComputerControlLaunch(
    ["serve", "--allow-computer-control", "--mode=single"],
    { PI_COMPUTER_CONTROL_CLIENT_IDS: "pi_1111111111111111" },
  );
  assert.equal(prepared.env.PI_COMPUTER_CONTROL_CLIENT_IDS, "pi_1111111111111111");
});

test("computer-control launch rejects collaboration and gateway modes", () => {
  assert.throws(
    () => prepareComputerControlLaunch(["start", "--mode", "collaboration", "--allow-computer-control"], {}),
    /Single agent mode/,
  );
  assert.throws(
    () => prepareComputerControlLaunch(["start", "--mode", "cli", "--allow-computer-control"], {}),
    /gateway mode/,
  );
  assert.throws(
    () => prepareComputerControlLaunch(["gateway", "start", "--allow-computer-control"], {}),
    /Single agent add-on/,
  );
});
