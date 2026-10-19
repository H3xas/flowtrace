using Bakery.Api.Pipelines;
using Bakery.Api.Services;
using Bakery.Api.Steps;
using Microsoft.Extensions.DependencyInjection;

namespace Bakery.Api
{
    public static class Startup
    {
        public static void ConfigureServices(IServiceCollection services)
        {
            services.AddScoped<IOrderService, OrderService>();
            services.AddScoped<ITastingService, TastingService>();
            services.AddScoped<IGlazeService, GlazeService>();
            services.AddScoped<ITastingRepository, TastingRepository>();
            services.AddScoped<IGlazePipeline, GlazePipeline>();
            services.AddScoped<ISprinklePipeline, SprinklePipeline>();
            services.AddScoped<ICrumbPipeline, CrumbPipeline>();

            services.AddScoped<ISprinkleStep, WalnutStep>();
            services.AddScoped<ISprinkleStep, CocoaStep>();
            services.AddScoped<ICrumbStep, ButterCrumbStep>();

            services.AddScoped<IPlacementPipeline>(ctx =>
            {
                var pipeline = new PlacementPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<CheckFlourStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<ReserveOvenStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<StampTicketStep>());
                return pipeline;
            });

            services.AddScoped<IDraftPipeline>(ctx =>
            {
                var pipeline = new DraftPipeline();
                return pipeline;
            });

            services.AddScoped<IPrecheckPipeline>(ctx =>
            {
                var pipeline = new PrecheckPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<CheckFlourStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<ReserveOvenStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<StampTicketStep>());
                return pipeline;
            });

            services.AddScoped<ICheckPipeline>(ctx =>
            {
                var pipeline = new CheckPipeline();
                pipeline.RegisterCheck(ctx.GetRequiredService<FlourCheck>());
                pipeline.RegisterCheck(ctx.GetRequiredService<SugarCheck>());
                pipeline.RegisterCheck(ctx.GetRequiredService<ButterCheck>());
                return pipeline;
            });

            services.AddScoped<IGrantPipeline>(ctx =>
            {
                var pipeline = new GrantPipeline();
                pipeline.RegisterRule(ctx.GetRequiredService<OwnerRule>());
                pipeline.RegisterRule(ctx.GetRequiredService<ManagerRule>());
                return pipeline;
            });

            services.AddScoped<ILayerPipeline>(ctx =>
            {
                var pipeline = new LayerPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer03Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer01Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer02Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer04Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer05Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer06Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer07Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer08Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer09Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer10Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer11Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer12Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer13Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer14Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer15Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer16Step>());
                pipeline.RegisterStep(ctx.GetRequiredService<CakeLayer17Step>());
                return pipeline;
            });

            services.AddScoped<IFrostingPipeline>(ctx =>
            {
                var pipeline = new FrostingPipeline();
                pipeline.RegisterStep(BuildFrostingStep(ctx));
                return pipeline;
            });

            services.AddScoped<IFillPipeline>(ctx =>
            {
                var pipeline = new FillPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<GlazeAndFillStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<PlainFillStep>());
                return pipeline;
            });

            services.AddScoped<ITopPipeline>(ctx =>
            {
                var pipeline = new TopPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<GlazeAndFillStep>());
                return pipeline;
            });

            services.AddScoped<IProofService, ProofService>();
            services.AddScoped<IStarterRepository, StarterRepository>();

            services.AddScoped<IProofPipeline>(ctx =>
            {
                var pipeline = new ProofPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<ProofDoughStep>());
                return pipeline;
            });

            services.AddScoped<ILooseProofPipeline>(ctx =>
            {
                var pipeline = new LooseProofPipeline();
                pipeline.RegisterStep(BuildProofStep(ctx));
                return pipeline;
            });

            AddCrumbExtras(services);
        }

        private static void AddCrumbExtras(IServiceCollection services)
        {
            services.AddScoped<ICrumbStep, OatCrumbStep>();
        }

        private static IProofStep BuildProofStep(System.IServiceProvider provider)
        {
            return provider.GetRequiredService<ProofDoughStep>();
        }

        private static IFrostingStep BuildFrostingStep(System.IServiceProvider provider)
        {
            return new VanillaFrostingStep();
        }
    }
}
