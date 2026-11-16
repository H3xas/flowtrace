namespace Ferry.Api.Routes;

public static class ApiRoutes
{
    public const string Root = "api";
    public const string Version = "v2";
    public const string Base = Root + "/" + Version;

    public static class Decks
    {
        public const string Upper = "upper", Lower = @"lower";
        public const string Car = $"{CarName}";
        private const string CarName = "car";
    }

    public static class Manifests
    {
        public const string Path = $"{Base}/manifests";
        public const string Stamp = nameof(Stamp);
    }
}
