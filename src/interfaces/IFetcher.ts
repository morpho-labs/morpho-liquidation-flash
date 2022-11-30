export interface IFetcher {
  fetchUsers: (lastId?: string) => Promise<{
    hasMore: boolean;
    users: string[];
    lastId: string;
  }>;
}
