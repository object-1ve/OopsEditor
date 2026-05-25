import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../store/editor";

export default function Terminal() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { terminalPath, terminalHeight } = useEditorStore();

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Listen for data from terminal
    term.onData((data) => {
      invoke("write_to_terminal", { data });
    });

    // Start terminal backend
    invoke("create_terminal", { path: terminalPath || "" });

    // Listen for output from backend
    const unlisten = listen<string>("terminal-output", (event) => {
      term.write(event.payload);
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      invoke("resize_terminal", {
        rows: term.rows,
        cols: term.cols,
      });
    };

    window.addEventListener("resize", handleResize);
    
    // Initial resize call after a short delay to ensure DOM is ready
    setTimeout(handleResize, 100);

    return () => {
      window.removeEventListener("resize", handleResize);
      unlisten.then((u) => u());
      term.dispose();
    };
  }, []);

  // Update terminal size when terminalHeight changes
  useEffect(() => {
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
      if (xtermRef.current) {
        invoke("resize_terminal", {
          rows: xtermRef.current.rows,
          cols: xtermRef.current.cols,
        });
      }
    }
  }, [terminalHeight]);

  return (
    <div 
      className="w-full h-full bg-[#1e1e1e] p-1"
      ref={terminalRef}
    />
  );
}
