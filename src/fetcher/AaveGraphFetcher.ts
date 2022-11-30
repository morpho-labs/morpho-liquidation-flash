import { Fetcher } from "../interfaces/Fetcher";
import axios from "axios";
import { GraphParams, GraphReturnType, User } from "./CompoundGraphFetcher";

export default class AaveGraphFetcher implements Fetcher {
  static QUERY = `query GetAccounts($first: Int, $lastId: ID){
      accounts(
          first: $first, 
          where: { id_gt: $lastId } 
          orderBy: id, 
          orderDirection: asc
      ) {
    id
    address
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
      .post<
        GraphParams,
        GraphReturnType<{ accounts: Omit<User, "isBorrower">[] }>
      >(this.graphUrl, {
        query: AaveGraphFetcher.QUERY,
        variables: { lastId, first: this.batchSize },
      })
      .then((r) => {
        if (r.data.errors) throw Error(JSON.stringify(r.data.errors));
        if (!r.data.data) throw Error("Unknown graph error");
        return r.data.data;
      });
    const newLastId =
      result.accounts.length === 0
        ? ""
        : result.accounts[result.accounts.length - 1].id;
    return {
      hasMore: result.accounts.length === this.batchSize,
      users: result.accounts.map((u) => u.address),
      lastId: newLastId,
    };
  }
}
