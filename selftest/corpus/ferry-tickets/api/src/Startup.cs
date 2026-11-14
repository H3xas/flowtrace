using Ferry.Api.Boarding;
using Ferry.Api.Checkin;
using Ferry.Api.Filters;
using Ferry.Api.Passengers;

namespace Ferry.Api;

public class Startup
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddScoped<IVoyageStore, VoyageStore>();
        services.AddScoped<IFareTable, FareTable>();
        services.AddScoped<IBoardingService, BoardingService>();
        services.AddControllers(options =>
        {
            options.Filters.Add(typeof(GateFaultFilter));
        });
        services.AddScoped<ITicketPackage, TicketPackage>();
        services.AddScoped<ISeatAccess, SeatAccess>();
        services.AddScoped<IPierDesk, PierDesk>();
        services.AddScoped<ICheckinPipeline>(ctx =>
        {
            var pipeline = new CheckinPipeline();
            pipeline.RegisterStep(ctx.GetRequiredService<TicketStep>());
            pipeline.RegisterStep(ctx.GetRequiredService<AccessStep>());
            pipeline.RegisterStep(ctx.GetRequiredService<PierStep>());
            return pipeline;
        });
    }
}
