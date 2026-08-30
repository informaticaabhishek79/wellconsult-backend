import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { verifyAccessToken } from '../../utils/jwt';
import { query, queryOne } from '../../config/database';
import { setEx, del, get } from '../../config/redis';
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

  io.on('connection', async (socket: Socket) => {
    const user = (socket as any).user;
    logger.info('Socket connected', { userId: user.sub, role: user.role });

    // Track doctor online status
    logger.info('Socket user info', { role: user.role, doctorId: user.doctorId, sub: user.sub });
    if (user.role === 'doctor') {
      const dId = user.doctorId || user.sub;
      // Join doctor's personal room so we can target them reliably
      socket.join(`doctor:${dId}`);
      try {
        await setEx(`doctor:online:${dId}`, 300, JSON.stringify({ doctorId: dId, socketId: socket.id }));
        io.emit('doctor_status', { doctorId: dId, status: 'online' });
        logger.info('Doctor online', { doctorId: dId });
      } catch(e) { logger.error('Failed to set doctor online', { error: (e as Error).message }); }
      // Refresh online status every 4 minutes
      const heartbeat = setInterval(async () => {
        await setEx(`doctor:online:${dId}`, 300, JSON.stringify({ socketId: socket.id })).catch(() => {});
      }, 4 * 60 * 1000);
      socket.on('disconnect', async () => {
        clearInterval(heartbeat);
        await del(`doctor:online:${dId}`).catch(() => {});
        io.emit('doctor_status', { doctorId: dId, status: 'offline' });
      });
    }

    // Handle instant consultation request (patient -> doctor)
    socket.on('instant_consult_request', async ({ doctorId, patientName, specialty }: { doctorId: string; patientName: string; specialty?: string }) => {
      try {
        const onlineData = await get(`doctor:online:${doctorId}`);
        if (!onlineData) { socket.emit('instant_consult_response', { status: 'offline' }); return; }
        const parsedData = JSON.parse(onlineData);
        // Send to doctor's personal room (more reliable than socket ID)
        io.to(`doctor:${doctorId}`).emit('instant_consult_incoming', {
          patientId: user.sub,
          patientName,
          requestId: `${user.sub}-${Date.now()}`,
          specialty,
        });
        // Store request for 2 minutes
        await setEx(`instant:${user.sub}:${doctorId}`, 120, JSON.stringify({ patientSocket: socket.id, doctorId }));
        socket.emit('instant_consult_response', { status: 'pending' });
      } catch (err) { socket.emit('instant_consult_response', { status: 'error' }); }
    });

    // Doctor responds to instant consultation request
    socket.on('instant_consult_accept', async ({ patientId, appointmentId }: { patientId: string; appointmentId?: string }) => {
      const key = await get(`instant:${patientId}:${user.doctorId}`);
      if (!key) return;
      const { patientSocket } = JSON.parse(key);
      io.to(patientSocket).emit('instant_consult_accepted', { doctorId: user.doctorId, appointmentId });
    });

    socket.on('instant_consult_decline', async ({ patientId, suggestedTime, surgeMultiplier }: { patientId: string; suggestedTime?: string; surgeMultiplier?: number }) => {
      const key = await get(`instant:${patientId}:${user.doctorId}`);
      if (!key) return;
      const { patientSocket } = JSON.parse(key);
      io.to(patientSocket).emit('instant_consult_declined', { doctorId: user.doctorId, suggestedTime, surgeMultiplier });
    });

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
