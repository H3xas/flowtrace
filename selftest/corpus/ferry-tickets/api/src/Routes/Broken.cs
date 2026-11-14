namespace Ferry.Api.Routes;

public static class LoopRoutes
{
    public const string First = Second + "/a";
    public const string Second = First + "/b";
}

public static class FareRoutes
{
    public const string Window = "window";
}
