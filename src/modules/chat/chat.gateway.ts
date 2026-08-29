import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { verifyAccessToken } from '../../utils/jwt';
import { query } from '../../config/database';
import { logger } from '../../utils/logger';

let io: SocketServer;

export function initSocketServer(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: {
      origin: [
        'https://wellconsult-web.onrender.com',
        'https://wellconsult-frontend.onrender.com',
        'http://localhost:3000',
        'http://localhost:8081',
      ],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || 
                    (socket.handshake.headers.authorization as string)?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));
      const payload = verifyAccessToken(token);
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    logger.info('Socket connected', { userId: user.sub, role: user.role });

    socket.on('join_room', async ({ appointmentId }: { appointmentId: string }) => {
      try {
        const [appt] = await query(
          `SELECT a.id, d.user_id AS doctor_user_id, p.user_id AS patient_user_id
           FROM appointments a
           JOIN doctors d ON d.id = a.doctor_id
           JOIN patients p ON p.id = a.patient_id
           WHERE a.id = $1`,
          [appointmentId]
        ) as any[];

        if (!appt) { socket.emit('error', { message: 'Appointment not found' }); return; }
        const hasAccess = appt.doctor_user_id === user.sub || appt.patient_user_id === user.sub;
        if (!hasAccess) { socket.emit('error', { message: 'Access denied' }); return; }

        const room = `appointment:${appointmentId}`;
        socket.join(room);

        const messages = await query(
          `SELECT cm.*, u.full_name AS sender_name
           FROM chat_messages cm
           JOIN users u ON u.id = cm.sender_id
           WHERE cm.appointment_id = $1
           ORDER BY cm.created_at ASC LIMIT 100`,
          [appointmentId]
        ) as any[];

        socket.emit('message_history', messages);
        socket.to(room).emit('user_joined', { userId: user.sub, role: user.role });
      } catch (err) {
        logger.error('join_room error', { error: (err as Error).message });
      }
    });

    socket.on('send_message', async ({ appointmentId, message }: { appointmentId: string; message: string }) => {
      try {
        if (!message?.trim()) return;
        const [msg] = await query(
          `INSERT INTO chat_messages (appointment_id, sender_id, message, message_type)
           VALUES ($1, $2, $3, 'text') RETURNING *`,
          [appointmentId, user.sub, message.trim()]
        ) as any[];
        const [sender] = await query('SELECT full_name FROM users WHERE id=$1', [user.sub]) as any[];
        const fullMsg = { ...msg, sender_name: sender?.full_name, role: user.role };
        io.to(`appointment:${appointmentId}`).emit('new_message', fullMsg);
      } catch (err) {
        logger.error('send_message error', { error: (err as Error).message });
      }
    });

    socket.on('typing', ({ appointmentId, isTyping }: { appointmentId: string; isTyping: boolean }) => {
      socket.to(`appointment:${appointmentId}`).emit('user_typing', { userId: user.sub, role: user.role, isTyping });
    });

    // Video room signaling
    socket.on('join_video_room', ({ roomId, sessionId, userId }: { roomId: string; sessionId: string; userId: string }) => {
      socket.join(`video:${roomId}`);
      // Tell new peer about existing peers in room
      const room = io.sockets.adapter.rooms.get(`video:${roomId}`);
      const peers: { sessionId: string; userId: string }[] = [];
      if (room) {
        for (const socketId of room) {
          const s = io.sockets.sockets.get(socketId);
          if (s && (s as any).videoSession && socketId !== socket.id) {
            peers.push({ sessionId: (s as any).videoSession, userId: (s as any).videoUserId });
          }
        }
      }
      // Store this peer's session
      (socket as any).videoSession = sessionId;
      (socket as any).videoUserId = userId;
      (socket as any).videoRoom = roomId;

      // Send existing peers to new joiner
      socket.emit('video_room_peers', peers);
      // Notify existing peers about new joiner
      socket.to(`video:${roomId}`).emit('peer_joined_video', { sessionId, userId });
      logger.info('Peer joined video room', { roomId, sessionId, userId });
    });

    socket.on('disconnect', () => {
      // Notify video room peers
      if ((socket as any).videoRoom) {
        socket.to(`video:${(socket as any).videoRoom}`).emit('peer_left_video', { userId: (socket as any).videoUserId });
      }
      logger.info('Socket disconnected', { userId: user.sub });
    });
  });

  logger.info('Socket.io initialized');
  return io;
}

export { io };
