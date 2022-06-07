import { Address } from "@graphprotocol/graph-ts";
import { Borrowed, Supplied } from "../generated/Morpho/Morpho";
import { User } from "../generated/schema";

function addUser(address: Address, isBorrower: boolean): void {
  let user = User.load(address.toHex());

  if (!user) {
    user = new User(address.toHex());
    user.address = address;
    user.isBorrower = false;
  }
  user.isBorrower = user.isBorrower || isBorrower;
  user.save();
}

export function handleBorrowed(event: Borrowed): void {
  addUser(event.params._borrower, true);
}
export function handleSupplied(event: Supplied): void {
  addUser(event.params._onBehalf, false);
}
