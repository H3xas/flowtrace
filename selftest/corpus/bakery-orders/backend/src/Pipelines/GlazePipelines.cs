using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Steps;
using Microsoft.Extensions.DependencyInjection;

namespace Bakery.Api.Pipelines
{
    public interface IGlazePipeline
    {
        Task<Glaze> ProcessAsync(Glaze glaze);
    }

    public class GlazePipeline : IGlazePipeline
    {
        private static readonly Type[] StepTypes = { typeof(ZestStep), typeof(AlmondStep) };
        private readonly List<IGlazeStep> _steps;

        public GlazePipeline(IServiceProvider provider)
        {
            _steps = StepTypes.Select(type => (IGlazeStep)provider.GetRequiredService(type)).ToList();
        }

        public async Task<Glaze> ProcessAsync(Glaze glaze)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(glaze);
                if (!glaze.Valid) return null;
            }

            return glaze;
        }
    }

    public interface ISprinklePipeline
    {
        Task<Glaze> ProcessAsync(Glaze glaze);
    }

    public class SprinklePipeline : ISprinklePipeline
    {
        private readonly List<ISprinkleStep> _steps;

        public SprinklePipeline(IEnumerable<ISprinkleStep> steps)
        {
            _steps = steps.ToList();
        }

        public async Task<Glaze> ProcessAsync(Glaze glaze)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(glaze);
                if (!glaze.Valid) return null;
            }

            return glaze;
        }
    }

    public interface ICrumbPipeline
    {
        Task<Glaze> ProcessAsync(Glaze glaze);
    }

    public class CrumbPipeline : ICrumbPipeline
    {
        private readonly List<ICrumbStep> _steps;

        public CrumbPipeline(IEnumerable<ICrumbStep> steps)
        {
            _steps = steps.ToList();
        }

        public async Task<Glaze> ProcessAsync(Glaze glaze)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(glaze);
                if (!glaze.Valid) return null;
            }

            return glaze;
        }
    }

    public interface IFrostingPipeline
    {
        Task<Glaze> ProcessAsync(Glaze glaze);
    }

    public class FrostingPipeline : IFrostingPipeline
    {
        private readonly List<IFrostingStep> _steps = new List<IFrostingStep>();

        public void RegisterStep(IFrostingStep step)
        {
            _steps.Add(step);
        }

        public async Task<Glaze> ProcessAsync(Glaze glaze)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(glaze);
                if (!glaze.Valid) return null;
            }

            return glaze;
        }
    }

    public interface IFillPipeline
    {
        Task<FillOrder> ProcessAsync(GlazeRequest request);
    }

    public class FillPipeline : IFillPipeline
    {
        private readonly List<IFillStep> _steps = new List<IFillStep>();

        public void RegisterStep(IFillStep step)
        {
            _steps.Add(step);
        }

        public async Task<FillOrder> ProcessAsync(GlazeRequest request)
        {
            var fill = new FillOrder(request);
            foreach (var step in _steps)
            {
                await step.ProcessAsync(fill);
                if (!fill.Valid) return null;
            }

            return fill;
        }
    }

    public interface ITopPipeline
    {
        Task<TopOrder> ProcessAsync(GlazeRequest request);
    }

    public class TopPipeline : ITopPipeline
    {
        private readonly List<ITopStep> _steps = new List<ITopStep>();

        public void RegisterStep(ITopStep step)
        {
            _steps.Add(step);
        }

        public async Task<TopOrder> ProcessAsync(GlazeRequest request)
        {
            var top = Prepare(request);
            foreach (var step in _steps)
            {
                await step.ProcessAsync(top);
                if (!top.Valid) return null;
            }

            return top;
        }

        private TopOrder Prepare(GlazeRequest request)
        {
            return new TopOrder { Flavour = request.Flavour };
        }
    }
}
