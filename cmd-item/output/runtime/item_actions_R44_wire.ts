// CMD ITEM runtime R44 wire stub (per LEAD inbox fix-task)
// 3 entry points consume CMD DB wrappers per CMD2 R44 Day 4 alert.
// CMD ENGINE consume this module + wire into combat / inventory flow.

import { withActionTxn } from '../../../../cmd-db/output/wrappers/w2_action_txn';
import { pickupItem } from '../../../../cmd-db/output/anti_dupe/anti_dupe';
import { optimisticUpdate } from '../../../../cmd-db/output/wrappers/w3_optimistic';

export interface ItemTransferInput {
  itemUuid: string;
  fromOwnerId: string;
  toOwnerId: string;
  battleId?: string;
}

// (1) withActionTxn('trade') around loot/transfer (R44 W2)
export async function transferItemAtomic(input: ItemTransferInput) {
  return withActionTxn('trade', async (tx) => {
    // Server-authoritative transfer; logs in item_transactions table.
    await pickupItem(tx, {
      itemUuid: input.itemUuid,
      newOwnerId: input.toOwnerId,
      action: 'trade',
    });
    return { ok: true, itemUuid: input.itemUuid };
  });
}

// (2) pickupItem (P1.3) replace existing item-pickup (R44 W2 anti-dupe)
export async function onItemDrop(itemUuid: string, ownerId: string) {
  return withActionTxn('pickup', async (tx) => {
    return pickupItem(tx, {
      itemUuid,
      newOwnerId: ownerId,
      action: 'pickup',
    });
  });
}

// (3) optimisticUpdate for inventory_row version-aware update (R44 W3)
export async function applyItemStatChange(
  itemUuid: string,
  patch: Record<string, unknown>,
  expectedVersion: number,
) {
  return optimisticUpdate('item_instances', {
    primaryKey: { item_uuid: itemUuid },
    expectedVersion,
    patch,
  });
}
