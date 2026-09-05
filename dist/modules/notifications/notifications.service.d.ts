interface SendParams {
    userId: string;
    type: string;
    title: string;
    body: string;
    refType?: string;
    refId?: string;
    fcmToken?: string;
}
export declare const NotificationService: {
    send(params: SendParams): Promise<void>;
    listForUser(userId: string, page: number, limit: number): Promise<{
        rows: Record<string, unknown>[];
        total: number;
        page: number;
        limit: number;
    }>;
    markRead(notifId: string, userId: string): Promise<void>;
    markAllRead(userId: string): Promise<void>;
};
export {};
