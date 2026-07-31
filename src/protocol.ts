import { NodeDetails } from './details/compute';

// the message contract between the expand-view webview (media/main.js) and the extension host;
// media/main.js must send/receive exactly these shapes

export interface WebviewToHostMessage {
    type: 'open' | 'close' | 'details' | 'callers';
    uri?: string;
    line?: number;
    character?: number;
    nodeId?: string;
    parentUri?: string;
    parentLine?: number;
    parentCharacter?: number;
    shouldShow?: boolean;
}

export interface DetailsReplyMessage {
    type: 'details';
    nodeId: string;
    details: NodeDetails | undefined;
}
