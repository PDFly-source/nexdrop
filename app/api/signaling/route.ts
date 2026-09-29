import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface EphemeralSession {
  sessionId: string;
  pin: string;
  securityToken: string;
  createdAt: number;
  expiresAt: number;
  peers: Set<string>;
  messages: Record<string, any[]>; // peerId -> array of queued messages
}

// In-memory ephemeral storage for active temporary sessions
// Explicitly stores NO file contents, only SDP & ICE candidates.
const sessions = new Map<string, EphemeralSession>();
const pinIndex = new Map<string, string>(); // PIN -> sessionId

// Prune expired sessions periodically
function pruneExpiredSessions() {
  try {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (session && session.expiresAt && session.expiresAt < now) {
        if (session.pin) pinIndex.delete(session.pin);
        sessions.delete(id);
      }
    }
  } catch (e) {
    // Ignore pruning errors
  }
}

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
};

export async function POST(req: NextRequest) {
  try {
    pruneExpiredSessions();
    const body = await req.json().catch(() => ({}));
    const { action, sessionId, pin, peerId, message, securityToken, token: inputToken } = body;

    if (action === 'create') {
      // Generate new ephemeral session or adopt client-generated session
      const newSessionId = (sessionId && typeof sessionId === 'string' && sessionId.trim())
        ? sessionId.trim()
        : (crypto.randomUUID ? crypto.randomUUID() : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
      
      const randomPin = (pin && /^\d{6}$/.test(pin.toString().trim()))
        ? pin.toString().trim()
        : Math.floor(100000 + Math.random() * 900000).toString();
      
      const token = (inputToken || securityToken || (crypto.randomUUID ? crypto.randomUUID() : `tok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`)).toString();

      const session: EphemeralSession = {
        sessionId: newSessionId,
        pin: randomPin,
        securityToken: token,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000, // 15 min TTL
        peers: new Set([peerId || 'host']),
        messages: {
          [peerId || 'host']: [],
        },
      };

      sessions.set(newSessionId, session);
      pinIndex.set(randomPin, newSessionId);

      return NextResponse.json(
        {
          success: true,
          sessionId: newSessionId,
          pin: randomPin,
          token,
          expiresInSeconds: 900,
        },
        { headers: jsonHeaders }
      );
    }

    if (action === 'join') {
      let targetSessionId = sessionId;
      if (!targetSessionId && pin) {
        targetSessionId = pinIndex.get(pin.toString().trim());
      }

      if (!targetSessionId || !sessions.has(targetSessionId)) {
        return NextResponse.json(
          { success: false, error: 'Session not found or has expired. Please check your PIN or QR code.' },
          { status: 404, headers: jsonHeaders }
        );
      }

      const session = sessions.get(targetSessionId)!;
      if (session.expiresAt < Date.now()) {
        sessions.delete(targetSessionId);
        pinIndex.delete(session.pin);
        return NextResponse.json(
          { success: false, error: 'Session expired' },
          { status: 410, headers: jsonHeaders }
        );
      }

      const joinerPeerId = peerId || (crypto.randomUUID ? crypto.randomUUID() : `peer_${Date.now()}`);
      session.peers.add(joinerPeerId);
      if (!session.messages[joinerPeerId]) {
        session.messages[joinerPeerId] = [];
      }

      // Notify other peers that a new peer joined
      for (const otherPeerId of session.peers) {
        if (otherPeerId !== joinerPeerId) {
          session.messages[otherPeerId]?.push({
            type: 'join',
            sessionId: targetSessionId,
            fromPeerId: joinerPeerId,
            timestamp: Date.now(),
          });
        }
      }

      return NextResponse.json(
        {
          success: true,
          sessionId: targetSessionId,
          pin: session.pin,
          peerId: joinerPeerId,
          token: session.securityToken,
        },
        { headers: jsonHeaders }
      );
    }

    if (action === 'send') {
      if (!sessionId || !sessions.has(sessionId)) {
        return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404, headers: jsonHeaders });
      }

      const session = sessions.get(sessionId)!;
      const fromId = peerId;
      const targetPeerId = message?.toPeerId;

      if (targetPeerId) {
        // Deliver to specific target peer
        if (!session.messages[targetPeerId]) session.messages[targetPeerId] = [];
        session.messages[targetPeerId].push(message);
      } else {
        // Broadcast to all other peers in the session
        for (const pId of session.peers) {
          if (pId !== fromId) {
            if (!session.messages[pId]) session.messages[pId] = [];
            session.messages[pId].push(message);
          }
        }
      }

      return NextResponse.json({ success: true }, { headers: jsonHeaders });
    }

    if (action === 'poll') {
      if (!sessionId || !sessions.has(sessionId)) {
        return NextResponse.json({ success: false, messages: [], active: false }, { headers: jsonHeaders });
      }

      const session = sessions.get(sessionId)!;
      const pId = peerId;
      const queued = session.messages[pId] || [];
      // Drain queued messages
      session.messages[pId] = [];

      return NextResponse.json(
        {
          success: true,
          active: true,
          messages: queued,
          peerCount: session.peers.size,
        },
        { headers: jsonHeaders }
      );
    }

    if (action === 'close') {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        pinIndex.delete(session.pin);
        sessions.delete(sessionId);
      }
      return NextResponse.json({ success: true }, { headers: jsonHeaders });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400, headers: jsonHeaders });
  } catch (error: any) {
    console.error('Signaling POST error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Internal signaling error' },
      { status: 500, headers: jsonHeaders }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    pruneExpiredSessions();
    const searchParams = req.nextUrl.searchParams;
    const action = searchParams.get('action');
    const sessionId = searchParams.get('sessionId');
    const peerId = searchParams.get('peerId');

    if (action === 'poll' && sessionId && peerId) {
      if (!sessions.has(sessionId)) {
        return NextResponse.json({ success: false, messages: [], active: false }, { headers: jsonHeaders });
      }
      const session = sessions.get(sessionId)!;
      const queued = session.messages[peerId] || [];
      session.messages[peerId] = [];
      return NextResponse.json(
        {
          success: true,
          active: true,
          messages: queued,
          peerCount: session.peers.size,
        },
        { headers: jsonHeaders }
      );
    }

    return NextResponse.json({ status: 'signaling-alive' }, { headers: jsonHeaders });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Signaling error' },
      { status: 500, headers: jsonHeaders }
    );
  }
}
