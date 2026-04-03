import { exec } from "child_process";
import open from "open";

function run(cmd) {
  return new Promise((res, rej) => {
    exec(cmd, (e, out) => (e ? rej(e) : res(out)));
  });
}

function getUrl(site) {
  const s = site.toLowerCase();

  if (s.includes("youtube")) return "https://youtube.com";
  if (s.includes("google")) return "https://google.com";
  if (s.includes("netflix")) return "https://netflix.com";

  return "https://" + s;
}

export async function handleCommand(cmd) {
  switch (cmd.type) {
    case "open_app":
      if (cmd.app.includes("chrome")) return run('start "" chrome');
      if (cmd.app.includes("spotify")) return run('start "" spotify');
      return;

    case "open_website":
      return open(getUrl(cmd.site));

    case "volume":
      if (cmd.action.includes("up"))
        return run('powershell (new-object -com wscript.shell).sendkeys([char]175)');
      if (cmd.action.includes("down"))
        return run('powershell (new-object -com wscript.shell).sendkeys([char]174)');
      if (cmd.action.includes("mute"))
        return run('powershell (new-object -com wscript.shell).sendkeys([char]173)');
      return;

    case "lock_pc":
      return run("rundll32.exe user32.dll,LockWorkStation");
  }
}