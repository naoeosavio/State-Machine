

import { new_mach, run, compute, register_action } from "../src/main";

// Simple benchmark runner
async function bench(name: string, fn: () => void, count: number = 100) {
  const start = performance.now();
  for (let i = 0; i < count; ++i) {
    fn();
  }
  const time = performance.now() - start;
  console.log(`${name.padEnd(25)}... ${Math.round(count / time * 1000).toLocaleString("en-US")} op/s, ${time.toFixed(3)}ms`);
}

// --- Test Setup ---

type MyState = {
  count: number;
};

type MyAction = {
  type: "add";
  value: number;
};

const game = {
  init: (): MyState => ({
    count: 0,
  }),
  when: (action: MyAction, state: MyState): MyState => {
    if (action.type === "add") {
      return { count: state.count + action.value };
    }
    return state;
  },
  tick: (state: MyState): MyState => {
    return state;
  },
};

// --- Benchmark ---

async function main() {
  console.log("Running benchmarks...");

  // --- Run benchmarks ---
  console.log("\n[Run Function]");
  const run_mach_no_rollback = new_mach<MyState, MyAction>(game,60, 10000);
  let run_time_no_rollback = 0;
  await bench("run (sequential)", () => {
    console.log(run(run_mach_no_rollback, game, { time: run_time_no_rollback++, type: "add", value: 1 }))
  });

//   // For the rollback test, we set up the machine inside the loop to ensure
//   // we're measuring a true rollback each time. The iteration count is lower
//   // because this is a much more expensive operation.
//   await bench("run (out-of-order)", () => {
//     const mach = new_mach<MyState, MyAction>(60, 10000);
//     for (let i = 0; i < 100; i++) {
//       run(mach, game, { time: i, type: "add", value: 1 });
//     }
//     // This is the operation being measured
//     run(mach, game, { time: 50, type: "add", value: 1 });
//   }, 1000);

//   // --- Compute benchmarks ---
//   console.log("\n[Compute Function]");
//   const compute_mach_no_rollback = new_mach<MyState, MyAction>(60, 10000);
//   let compute_time_no_rollback = 0;
//   await bench("compute (sequential)", () => {
//     register_action(compute_mach_no_rollback, { time: compute_time_no_rollback, type: "add", value: 1 });
//     compute(compute_mach_no_rollback, game, compute_time_no_rollback++);
//   });

//   // Same logic for the compute rollback test.
//   await bench("compute (out-of-order)", () => {
//     const mach = new_mach<MyState, MyAction>(60, 10000);
//     for (let i = 0; i < 100; i++) {
//         register_action(mach, { time: i, type: "add", value: 1 });
//         compute(mach, game, i);
//     }
//     // This is the operation being measured
//     register_action(mach, { time: 50, type: "add", value: 1 });
//     compute(mach, game, 50);
//   }, 1000);

//   console.log("\n...done.");
}

main().catch(console.error);



// const machines: { [id: string]: PaymentMach<PaymentState, PaymentEvent> } = {};

// function processPayment(id: string, event: PaymentEvent) {
//   if (!machines[id]) {
//     machines[id] = new_mach();
//   }
//   return run(machines[id], paymentMachine, event);
// }

// // Simulação assíncrona
// async function simulatePayment() {
//   const id = "pay2";
//   const now = Date.now();
//   let state = processPayment(id, { $: "Initiate", id, eventId: generateEventId(), time: now, amount: 200 });
//   await new Promise(resolve => setTimeout(resolve, 100));
//   state = processPayment(id, { $: "SendToService", id, eventId: generateEventId(), time: now + 100, service: "A" });
//   await new Promise(resolve => setTimeout(resolve, 100));
//   state = processPayment(id, { $: "ResponseReceived", id, eventId: generateEventId(), time: now + 200, success: true });
//   console.log(state); // { id: "pay2", status: "completed", amount: 200, ... }
// }

// anter a FSM 100 % pura e colocar tudo que toca I/O em uma camada externa.
// A arquitetura fica assim:

// ┌──────────┐  run(machine,event)   ┌────────────────────┐
// │ drivers  │ ───────────────────▶│  FSM (pura)        │
// │ (HTTP,   │                    │  init / reduce /   │
// │ timer…)  │ ◀─ newState         │  update            │
// └──────────┘                    └────────────────────┘
//         │                                │
//         └───── side-effects(prev,next) ──┘   ← fora da FSM

// 1 · Implementação mínima

// /* ---------- domínio puro ---------- */
// type State  = { balance: number; settled: boolean };
// type Event  = { type: "PAY"; value: number } |
//               { type: "SETTLE" };

// const init   = (): State => ({ balance: 0, settled: false });

// const reduce = (ev: Event, s: State): State => {
//   switch (ev.type) {
//     case "PAY":    return { ...s, balance: s.balance + ev.value };
//     case "SETTLE": return { ...s, settled: true };
//   }
// };

// const update = (s: State): State => s;        // opcional

// /* ---------- casca que guarda estado ---------- */
// export const fsm: Machine<State, Event> = {
//   init,
//   reduce,
//   update,
// };

// // Exemplo de uso com run e compute
// const mach: Mach<State, Event> = new_mach();


// Nenhum side-effect dentro da FSM

// // OK: apenas lógica pura
// fsm.run(mach,fsm,{ type: "PAY", value: 10 });
// console.log(fsm.getState());          // { balance: 10, settled: false }

// 2 · Camada externa de efeitos

// function actOnTransition(prev: State, next: State) {
//   if (!prev.settled && next.settled) {
//     queueEmail("Pagamento concluído!");  // I/O fora da FSM
//   }
// }

// // “driver” genérico que combina FSM + efeitos  ---------
// function handle(evt: Event) {
//   const prev = fsm.getState();
//   fsm.run(mach,fsm,evt);
//   const next = fsm.getState();
//   actOnTransition(prev, next);
// }

// Agora os drivers ficam livres

// // Webhook
// app.post("/pay", (req,res) => {
//   handle({ type:"PAY", value:req.body.amount });
//   res.sendStatus(200);
// });

// // Cron job
// setInterval(() => handle({ type:"SETTLE" }), 86_400_000);

//     Resultado:
//     FSM continua totalmente testável e determinística;
//     logs, e-mails, gravação em banco vivem num lugar separado e
//     só recebem (prev, next).


// Escolha a que melhor se encaixa no seu projeto; todas mantêm a separação “regra de negócio pura” ↔ “mundo exterior”.
// TL;DR

//     Sim, todos os side-effects podem (e idealmente devem) ficar fora da FSM.

//     A FSM expõe apenas run; o restante é orquestrado por drivers externos ou middlewares.

//     Isso garante código determinístico, testável e fácil de evoluir — enquanto ainda permite log, persistência e notificações onde for necessário.



// server.adapter(value)
// server.attach(port, options)
// server.attachApp(app, options)
// server.bind(engine)
// server.close(callback)
// server.disconnect(close)
// server.emit(eventName, ...args)
// server.emitWithAck(eventName, ...args)
// server.except(rooms)
// server.fetch()
// server.in(room)
// server.listen(port, options)
// server.of(nsp)
// server.on(eventName, listener)
// server.onconnection(socket)
// server.path(value)
// server.timeout(value)
// server.to(room)
// server.use(fn)