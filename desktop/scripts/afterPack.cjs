const { constants } = require("node:fs");
const { access, chmod, copyFile, rename } = require("node:fs/promises");
const path = require("node:path");

exports.default = async function installLinuxLauncher(context) {
  if (context.electronPlatformName !== "linux") return;

  const executableName = context.packager.executableName;
  if (typeof executableName !== "string" || executableName.length === 0) {
    throw new Error("afterPack: Linux executableName is missing");
  }

  const electronBinary = path.join(context.appOutDir, executableName);
  const wrappedBinary = path.join(context.appOutDir, `${executableName}-bin`);
  const launcher = path.join(__dirname, "..", "build", "tavern-linux-launcher.sh");

  await access(electronBinary, constants.X_OK);
  await rename(electronBinary, wrappedBinary);
  await copyFile(launcher, electronBinary);
  await chmod(electronBinary, 0o755);
};
