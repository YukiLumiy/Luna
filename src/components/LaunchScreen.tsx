import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errText } from "../api";
import { MoonIcon } from "./MoonIcon";

type Status = "idle" | "starting" | "running";

export function LaunchScreen() {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    const un = listen("roblox-exited", () => {
      setStatus("idle");
      setMessage("Roblox が終了しました");
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const launch = async () => {
    if (status !== "idle") return;
    setStatus("starting");
    setMessage("");
    try {
      const folder = await api.launch();
      setStatus("running");
      setMessage(folder);
    } catch (e) {
      setStatus("idle");
      setMessage(errText(e));
    }
  };

  const label = status === "idle" ? "Launch" : status === "starting" ? "起動中…" : "実行中";

  return (
    <section className="screen center">
      <MoonIcon size={132} glow />
      <h1 className="title">Luna</h1>
      <button className="btn primary big" disabled={status !== "idle"} onClick={launch}>
        {label}
      </button>
      <p className={"hint" + (status === "idle" && message ? " error" : "")}>{message}</p>
    </section>
  );
}
