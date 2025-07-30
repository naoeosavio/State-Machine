export type Time = number;
export type Tick = number;
type T<A> = A & {
    time: Time;
};
export type StateLogs<S> = Record<Tick, S>;
export type ActionLogs<A> = Record<Tick, T<A>[]>;
export type Mach<S, A> = {
    ticks_per_second: number;
    max_tick_travel: Tick;
    genesis_tick: Tick;
    cached_tick: Tick;
    state_logs: StateLogs<S>;
    action_logs: ActionLogs<A>;
};
export type Game<S, A> = {
    init: () => S;
    when: (action: T<A>, state: S) => S;
    tick: (state: S) => S;
};
export declare function new_mach<S, A>(ticks_per_second: number, max_time_travel: number): Mach<S, A>;
export declare function time_to_tick<S, A>(mach: Mach<S, A>, time: Time): Tick;
export declare function register_action<S, A>(mach: Mach<S, A>, action: T<A>): void;
export declare function compute<S, A>(mach: Mach<S, A>, game: Game<S, A>, time: Time): S;
export declare function run<S, A>(mach: Mach<S, A>, game: Game<S, A>, action: T<A>): S;
export declare function commit<S, A>(mach: Mach<S, A>, time: Time): void;
export declare function serialize_machine<S, A>(mach: Mach<S, A>): string;
export declare function deserialize_machine<S, A>(json_string: string): Mach<S, A>;
export declare function reset_machine<S, A>(mach: Mach<S, A>): void;
export declare function get_state_at_tick<S, A>(mach: Mach<S, A>, tick: Tick): S | undefined;
export declare function get_action_at_tick<S, A>(mach: Mach<S, A>, tick: Tick): T<A>[] | undefined;
export declare function get_State<S, A>(mach: Mach<S, A>): S | undefined;
export {};
