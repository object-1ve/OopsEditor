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
  isExpanded: boolean;
}

export default function Terminal({ id, path, isVisible, isExpanded }: TerminalProps) {
  const terminalViewportRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { terminalHeight } = useEditorStore();

  useEffect(() => {
    if (!terminalViewportRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'SF Mono', 'Consolas', 'Liberation Mono', Menlo, Courier, monospace",
      lineHeight: 1.28,
      letterSpacing: 0,
      fontWeight: "400",
      fontWeightBold: "600",
      scrollback: 10000,
      scrollOnUserInput: true,
      tabStopWidth: 4,
      theme: {
        background: "#0f1117",
        foreground: "#e6edf3",
        cursor: "#f0f6fc",
        cursorAccent: "#0f1117",
        selectionBackground: "#264f78",
        selectionInactiveBackground: "#1b2533",
        black: "#0f1117",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#d0d7de",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalViewportRef.current);
    
    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 50);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const syncTerminalSize = async () => {
      fitAddon.fit();
      if (term.rows > 0 && term.cols > 0) {
        await invoke("resize_terminal", {
          id,
          rows: term.rows,
          cols: term.cols,
        });
      }
    };

    // Listen for data from terminal
    term.onData((data) => {
      invoke("write_to_terminal", { id, data });
    });

    term.onResize(({ rows, cols }) => {
      invoke("resize_terminal", { id, rows, cols }).catch((err) => {
        console.error(`Failed to resize terminal ${id}:`, err);
      });
    });

    // Start terminal backend
    invoke("create_terminal", { id, path: path || "" })
      .then(() => syncTerminalSize())
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
      syncTerminalSize().catch((err) => {
        console.error(`Failed to sync terminal ${id} size:`, err);
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
        if (xtermRef.current && xtermRef.current.rows > 0 && xtermRef.current.cols > 0) {
          invoke("resize_terminal", {
            id,
            rows: xtermRef.current.rows,
            cols: xtermRef.current.cols,
          }).catch((err) => {
            console.error(`Failed to resize terminal ${id}:`, err);
          });
        }
      }, 50);
    }
  }, [terminalHeight, isVisible, isExpanded, id]);

  return (
    <div className={`terminal-shell w-full h-full overflow-hidden ${isVisible ? "block" : "hidden"}`}>
      <div
        ref={terminalViewportRef}
        className="terminal-shell__viewport h-full w-full overflow-hidden"
      />
    </div>
  );
}
