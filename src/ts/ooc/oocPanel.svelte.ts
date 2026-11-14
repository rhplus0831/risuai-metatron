/** The App-mounted OOC panel keeps its composer text when closed. */
export const oocPanel = $state({ open: false });

export function openOocPanel() {
    oocPanel.open = true;
}

export function closeOocPanel() {
    oocPanel.open = false;
}
