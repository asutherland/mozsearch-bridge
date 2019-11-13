import { InsideIframeBroadcastChannelBridge } from './bridge/msg_handler.js';

const clientBridge = new InsideIframeBroadcastChannelBridge({ win: window });
