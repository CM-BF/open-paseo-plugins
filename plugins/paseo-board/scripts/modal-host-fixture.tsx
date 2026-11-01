// Native fallback in a browser harness: the adapter reports ios to production
// canRenderFrames and re-roots Modal.Content without plugin-owned contexts.
import { createContext, createElement, useContext, useState } from "react";
// @ts-expect-error ReactDOM is only used by the fixture.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToolbarPopover } from "../client/toolbar-popover";
import { Action, ColorContext, Copy, useColors } from "../client/ui";
import { DEFAULT_LIGHT_COLORS, DEFAULT_DARK_COLORS } from "../shared/frame-theme";
const browser=globalThis as any;
browser.hostFixture={links:[],calls:[]};
const Probe=createContext("unbridged");
function ModalBody(){const theme=useColors(),probe=useContext(Probe);return <><div data-testid="native-modal-theme" data-probe={probe} data-color={theme.foreground} style={{color:theme.foreground}}><Copy>Native fallback retained its explicit theme</Copy><input data-testid="native-modal-input" defaultValue="draft" /></div></>}
function App(){const[open,setOpen]=useState(false);return <div data-testid="native-toolbar-container"><Action label="Open native toolbar" onPress={()=>setOpen(true)}/><ToolbarPopover open={open} title="Native toolbar" onClose={()=>setOpen(false)} containerId="native-toolbar-container" testID="unused-web-popover"><ModalBody/></ToolbarPopover></div>}
const query = new QueryClient();
function ThemeRoot(){const[dark,setDark]=useState(false);browser.hostFixture.switchTheme=()=>setDark(value=>!value);browser.hostFixture.expectedDark=DEFAULT_DARK_COLORS.foreground;return createElement(QueryClientProvider,{client:query},createElement(ColorContext.Provider,{value:dark?DEFAULT_DARK_COLORS:DEFAULT_LIGHT_COLORS},createElement(Probe.Provider,{value:"outer-context-must-not-leak"},createElement(App))))}
createRoot(browser.document.getElementById("app")).render(createElement(ThemeRoot));
