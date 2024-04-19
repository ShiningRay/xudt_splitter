require('dotenv').config()
import { AddressPrefix, addressToScript, getTransactionSize, privateKeyToAddress, serializeWitnessArgs } from '@nervosnetwork/ckb-sdk-utils';
import { getSecp256k1CellDep, Collector, NoLiveCellError, calculateUdtCellCapacity, MAX_FEE, MIN_CAPACITY, append0x, u128ToLe, getXudtDep, getUniqueTypeDep, SECP256K1_WITNESS_LOCK_SIZE, calculateTransactionFee, NoXudtLiveCellError, leToU128 } from '@rgbpp-sdk/ckb';
import { logger } from "./utils/logger"
import { log } from 'console';


const XudtType = {
  codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hashType: 'type',
  args: '0xbd23085b46a45fdeaf08010bc3b65b657e3175624258183cd279e866353e31f3'
}

type Hex = string


async function splitCell() {
  console.log('start split cell')
  // 初始化收集器
  const collector = new Collector({
    ckbNodeUrl: 'https://testnet.ckb.dev/rpc',
    ckbIndexerUrl: 'https://testnet.ckb.dev/indexer',
  });
  // 是否是主网
  const isMainnet = process.env.IS_MAINNET === 'true'
  // 获取本地地址
  const CKB_PRIVATE_KEY = process.env.PRIVATE_KEY
  if (!CKB_PRIVATE_KEY) {
    logger.error(new Error('private key is empty'))
    return
  }
  const fromAddress = privateKeyToAddress(CKB_PRIVATE_KEY, {
    prefix: isMainnet ? AddressPrefix.Mainnet : AddressPrefix.Testnet,
  });
  logger.info(`from address: ${fromAddress}`)
  // 获取本地地址的lock
  const fromLock = addressToScript(fromAddress);
  // xudt的类型
  if (!process.env.XUDT_CODE_HASH || !process.env.XUDT_HASH_TYPE || !process.env.XUDT_ARGS) {
    logger.error(new Error('xudt type is empty'))
    return
  }
  if (!process.env.TARGET_ADDRESS) {
    logger.error(new Error('target address is empty'))
    return
  }
  if (!process.env.MIN_AVAILABLE_CELLS || !process.env.QUANTITY_PER_CELL) {
    logger.error(new Error('MIN_AVAILABLE_CELLS or QUANTITY_PER_CELL is empty'))
    return
  }
  const xudtType = {
    codeHash: process.env.XUDT_CODE_HASH,
    hashType: process.env.XUDT_HASH_TYPE,
    args: process.env.XUDT_ARGS
  } as CKBComponents.Script
  logger.info(`xudtType: ${JSON.stringify(xudtType)}`)

  let cellInputCapacity = BigInt(0)

  let totalTransferAmount = BigInt(0)
  let outputCapacity = BigInt(0)
  let txOutputs: CKBComponents.CellOutput[] = []
  let txInputs: CKBComponents.CellInput[] = []
  let outputsData: Hex[] = []
  let targetXudtCellsCount = 0
  // 判断目标地址是否足够空余的cell
  const targetAddress = process.env.TARGET_ADDRESS
  if (!targetAddress) {
    logger.error(new Error('target address is empty'))
    return
  }
  const targetLock = addressToScript(targetAddress)
  // 获取目标地址的xudt cell
  const targetXudtCells = await collector.getCells({
    lock: targetLock,
    type: xudtType,
  })
  if (!targetXudtCells || targetXudtCells.length === 0) {
    targetXudtCellsCount = 0
  }else{
    targetXudtCellsCount = targetXudtCells.length
  }
  console.log('targetXudtCellsCount: ', targetXudtCellsCount)
  // 计算本地地址的xudt余额
  const fromXudtCells = await collector.getCells({
    lock: fromLock,
    type: xudtType,
  });
  if (!fromXudtCells || fromXudtCells.length === 0) {
    logger.error(new Error('from address has no xudt cells'))
    return
  }
  const fromXudtBalance = fromXudtCells.reduce((prev, current) => prev + BigInt(leToU128(current.outputData)), BigInt(0))
  
  if (!process.env.MIN_AVAILABLE_CELLS || !process.env.QUANTITY_PER_CELL) {
    logger.error(new Error('MIN_AVAILABLE_CELLS or QUANTITY_PER_CELL is empty'))
    return
  }
  if (targetXudtCellsCount >= parseInt(process.env.MIN_AVAILABLE_CELLS)){
    logger.info('target address has enough cells')
    return
  } else {// xudtCells小于MIN_AVAILABLE_CELLS, 进行拆分
    // 计算需要拆分的数量
    let needCount = parseInt(process.env.MIN_AVAILABLE_CELLS) - targetXudtCellsCount
    // 如果本地的xudt余额不足以支付拆分的数量, 设置为可以拆分的上限
    if (BigInt(needCount) * BigInt(process.env.QUANTITY_PER_CELL) > fromXudtBalance) {
      needCount = Number(fromXudtBalance / BigInt(process.env.QUANTITY_PER_CELL))
    }
    logger.info(`needCount: ${needCount}`)
    // 进行对应转账的操作
    // 1. 构造xudt inputs
    totalTransferAmount = BigInt(needCount) * BigInt(process.env.QUANTITY_PER_CELL)
    const { inputs, sumInputsCapacity, sumAmount } = collector.collectUdtInputs({
      liveCells: fromXudtCells,
      needAmount: totalTransferAmount,
    })
    txInputs.push(...inputs)
    cellInputCapacity += sumInputsCapacity
    // 2. 构造xudt outputs
    const xudtCapacity = calculateUdtCellCapacity(targetLock, xudtType)
    const fromXudtCapacity = calculateUdtCellCapacity(fromLock, xudtType)
    console.log('xudtCapacity: ', xudtCapacity)
    console.log('fromXudtCapacity: ', fromXudtCapacity)
    for (let i = 0; i < needCount; i++) {
      txOutputs.push({
        lock: targetLock,
        type: xudtType,
        capacity: append0x(xudtCapacity.toString(16)),
      })
      outputsData.push(append0x(u128ToLe(BigInt(process.env.QUANTITY_PER_CELL))))
      outputCapacity += xudtCapacity
    }
    // 3. 构造xudt找零
    const changeXudtAmount = sumAmount - totalTransferAmount
    if (changeXudtAmount > 0) {
      txOutputs.push({
        lock: fromLock,
        type: xudtType,
        capacity: append0x(fromXudtCapacity.toString(16)),
      })
      outputsData.push(append0x(u128ToLe(changeXudtAmount)))
      outputCapacity += fromXudtCapacity
    }
    // 4. 补充inputs
    if (cellInputCapacity < outputCapacity + MAX_FEE) {
      const emptyCells = await collector.getCells({
        lock: fromLock,
      });
      if (!emptyCells || emptyCells.length === 0) {
        logger.error(new Error('from address has no empty cells'))
        return
      }
      const needCapacity = outputCapacity - cellInputCapacity
      const { inputs: emptyInputs, sumInputsCapacity: sumEmptyCapacity } = collector.collectInputs(
        emptyCells,
        needCapacity,
        MAX_FEE,
        { minCapacity: MIN_CAPACITY },
      );
      console.log('emptyInputs: ', emptyInputs)
      cellInputCapacity += sumEmptyCapacity
      txInputs.push(...emptyInputs)
    }
    // 5. empty cell找零
    const changeCapacity = cellInputCapacity - outputCapacity - MAX_FEE
    console.log('changeCapacity: ', changeCapacity)
    console.log('cellInputCapacity: ', cellInputCapacity)
    console.log('outputCapacity: ', outputCapacity)
    if (changeCapacity > 0) {
      txOutputs.push({
        lock: fromLock,
        capacity: append0x(changeCapacity.toString(16)),
      })
      outputsData.push('0x')
      outputCapacity += changeCapacity
    }
    const diff = cellInputCapacity - outputCapacity
    logger.info(`diff: ${diff}`)
    logger.info(`cellInputCapacity: ${cellInputCapacity}`)
    logger.info(`outputCapacity: ${outputCapacity}`)
    if (diff < MAX_FEE) {
      logger.error(new Error('cell input capacity is not enough'))
      return
    }
    // 6. 构造交易
    const cellDeps = [getSecp256k1CellDep(isMainnet), getXudtDep(isMainnet)]
    const emptyWitness = { lock: '', inputType: '', outputType: '' };
    const witnesses = [emptyWitness];
    const unsignedTx = {
      version: '0x0',
      cellDeps,
      headerDeps: [],
      inputs: txInputs,
      outputs: txOutputs,
      outputsData,
      witnesses: witnesses,
    };
    logger.info(`unsignedTx: ${JSON.stringify(unsignedTx, null, 2)}`)
    const signedTx = collector.getCkb().signTransaction(CKB_PRIVATE_KEY)(unsignedTx);
    const txHash = await collector.getCkb().rpc.sendTransaction(signedTx, 'passthrough');
    logger.info(`split cell tx hash: ${txHash}`)
  }
}

// 立即执行一次
splitCell();
// 周期性检查
setInterval(splitCell, parseInt(process.env.CHECK_INTERVAL || '10000'))
