declare class PassiveStreamParser {
    [key: string]: any;
    constructor();
    push(raw: any): any;
    reset(): void;
}
export { PassiveStreamParser };
