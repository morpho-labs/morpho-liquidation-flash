export interface Fetcher {
  fetchUsers: (lastId?: string) => Promise<{
    hasMore: boolean;
    users: string[];
    lastId: string;
  }>;
}
