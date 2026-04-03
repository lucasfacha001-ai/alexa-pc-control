import { exec } from "child_process";
import open from "open";

function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message} | stderr: ${stderr}`));
        return;
      }

      resolve({
        command,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || ""
      });
    });
  });
}

function normalizeAppName(app) {
  return (app || "").toLowerCase().trim();
}

function siteToUrl(site) {
  const value = (site || "").toLowerCase().trim();

  if (value.includes("youtube")) return "https://www.youtube.com";
  if (value.includes("google")) return "https://www.google.com";
  if (value.includes("gmail")) return "https://mail.google.com";
  if (value.includes("netflix")) return "https://www.netflix.com";
  if (value.includes("twitch")) return "https://www.twitch.tv";

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return `https://${value}`;
}

export async function handleCommand(command) {
  switch (command.type) {
    case "open_app": {
      const app = normalizeAppName(command.app);

      if (app.includes("chrome")) {
        return await run('start "" chrome');
      }

      if (app.includes("spotify")) {
        return await run('start "" spotify');
      }

      if (app.includes("bloc de notas") || app.includes("notepad")) {
        return await run('start "" notepad');
      }

      if (app.includes("discord")) {
        return await run('start "" discord');
      }

      if (app.includes("steam")) {
        return await run('start "" steam');
      }

      throw new Error(`Unsupported app: ${command.app}`);
    }

    case "open_website": {
      const url = siteToUrl(command.site);
      await open(url);
      return { openedUrl: url };
    }

    case "volume": {
      const action = (command.action || "").toLowerCase();

      if (action === "up") {
        return await run('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
      }

      if (action === "down") {
        return await run('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
      }

      if (action === "mute") {
        return await run('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"');
      }

      throw new Error(`Unsupported volume action: ${command.action}`);
    }

    case "lock_pc": {
      return await run("rundll32.exe user32.dll,LockWorkStation");
    }

    case "sleep_pc": {
      return await run('powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState(\'Suspend\', $false, $false)"');
    }

    case "shutdown_pc": {
      return await run("shutdown /s /t 0");
    }

    default:
      throw new Error(`Unsupported command type: ${command.type}`);
  }
}