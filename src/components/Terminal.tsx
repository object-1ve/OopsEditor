import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../store/editor";

interface TerminalProps {
  id: string;
  path: string | null;
  isVisible: boolean;
}

export default function Terminal({ id, path, isVisible }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { terminalHeight } = useEditorStore();

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Consolas', 'Liberation Mono', Menlo, Courier, monospace",
      lineHeight: 1.2,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
        cursorAccent: "#1e1e1e",
        selectionBackground: "#ffffff40",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    
    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 50);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Listen for data from terminal
    term.onData((data) => {
      invoke("write_to_terminal", { id, data });
    });

    // Start terminal backend
    invoke("create_terminal", { id, path: path || "" })
      .catch(err => {
        console.error(`Failed to create terminal ${id}:`, err);
        term.write(`\r\n\x1b[31mError: Failed to connect to terminal backend.\x1b[0m\r\n${err}\r\n`);
      });

    // Listen for output from backend
    const eventName = `terminal-output-${id}`;
    const unlisten = listen<string>(eventName, (event) => {
      term.write(event.payload);
    });

    // Handle resize
    const handleResize = () => {
      if (!isVisible) return;
      fitAddon.fit();
      invoke("resize_terminal", {
        id,
        rows: term.rows,
        cols: term.cols,
      });
    };

    window.addEventListener("resize", handleResize);
    
    return () => {
      window.removeEventListener("resize", handleResize);
      unlisten.then((u) => u());
      invoke("close_terminal", { id });
      term.dispose();
    };
  }, []); // Only run once on mount

  // Update terminal size when terminalHeight or visibility changes
  useEffect(() => {
    if (isVisible && fitAddonRef.current && xtermRef.current) {
      // Need a small delay to ensure DOM is updated
      setTimeout(() => {
        fitAddonRef.current?.fit();
        if (xtermRef.current) {
          invoke("resize_terminal", {
            id,
            rows: xtermRef.current.rows,
            cols: xtermRef.current.cols,
          });
        }
      }, 50);
    }
  }, [terminalHeight, isVisible, id]);

  return (
    <div 
      className={`w-full h-full bg-[#1e1e1e] pl-4 pt-2 ${isVisible ? "block" : "hidden"}`}
      ref={terminalRef}
    />
  );
}
