import { IFetcher } from "../interfaces/IFetcher";
import axios from "axios";

export interface User {
  id: string;
  address: string;
  isBorrower: boolean;
}
export type GraphReturnType<T> = { data: { data?: T; errors?: object } };
export type GraphParams = { query: string; variables: object };

export default class CompoundGraphFetcher implements IFetcher {
  static QUERY = `query GetAccounts($first: Int, $lastId: ID){
      users(
          first: $first 
          where: {id_gt: $lastId isBorrower: true} 
          orderBy: id, 
          orderDirection: asc
      ) {
        id
        address
        isBorrower
    }
}`;

  public batchSize: number;

  constructor(public graphUrl: string, batchSize?: number) {
    if (!batchSize) {
      const fromEnv = process.env.BATCH_SIZE;
      if (fromEnv && !isNaN(parseInt(fromEnv))) {
        batchSize = parseInt(fromEnv);
      }
      batchSize = 1000;
    }
    this.batchSize = batchSize;
  }

  async fetchUsers(
    lastId: string = ""
  ): Promise<{ hasMore: boolean; users: string[]; lastId: string }> {
    const result = await axios
      .post<GraphParams, GraphReturnType<{ users: User[] }>>(this.graphUrl, {
        query: CompoundGraphFetcher.QUERY,
        variables: { lastId, first: this.batchSize },
      })
      .then((r) => {
        if (r.data.errors) throw Error(JSON.stringify(r.data.errors));
        if (!r.data.data) throw Error("Unknown graph error");
        return r.data.data;
      });
    const newLastId =
      result.users.length === 0 ? "" : result.users[result.users.length - 1].id;
    return {
      hasMore: result.users.length === this.batchSize,
      users: result.users.map((u) => u.address),
      lastId: newLastId,
    };
  }
}
