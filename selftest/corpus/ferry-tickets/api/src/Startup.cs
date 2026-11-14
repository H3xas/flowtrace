using Ferry.Api.Passengers;

namespace Ferry.Api;

public class Startup
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddScoped<IVoyageStore, VoyageStore>();
        services.AddScoped<IFareTable, FareTable>();
    }
}
