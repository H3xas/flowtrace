using System.Collections.Generic;
using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Steps;

namespace Bakery.Api.Pipelines
{
    public interface IPlacementPipeline
    {
        Task<Order> ProcessAsync(Order order);
    }

    public class PlacementPipeline : IPlacementPipeline
    {
        private readonly List<IOrderStep> _steps = new List<IOrderStep>();

        public void RegisterStep(IOrderStep step)
        {
            _steps.Add(step);
        }

        public async Task<Order> ProcessAsync(Order order)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(order);

                if (!order.Valid)
                {
                    return null;
                }
            }

            return order;
        }
    }

    public interface IDraftPipeline
    {
        Task<Order> ProcessAsync(Order order);
    }

    public class DraftPipeline : IDraftPipeline
    {
        private readonly List<IOrderStep> _steps = new List<IOrderStep>();

        public void RegisterStep(IOrderStep step)
        {
            _steps.Add(step);
        }

        public async Task<Order> ProcessAsync(Order order)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(order);

                if (!order.Valid)
                {
                    return null;
                }
            }

            return order;
        }
    }

    public interface IPrecheckPipeline
    {
        Task<Order> ProcessAsync(Order order);
    }

    public class PrecheckPipeline : IPrecheckPipeline
    {
        private readonly List<IOrderStep> _steps = new List<IOrderStep>();

        public void RegisterStep(IOrderStep step)
        {
            _steps.Add(step);
        }

        public async Task<Order> ProcessAsync(Order order)
        {
            foreach (var step in _steps)
            {
                if (!order.Valid) return null;
                await step.ProcessAsync(order);
            }

            return order;
        }
    }

    public interface ICheckPipeline
    {
        bool Process(Order order);
    }

    public class CheckPipeline : ICheckPipeline
    {
        private readonly List<IOrderCheck> _checks = new List<IOrderCheck>();

        public void RegisterCheck(IOrderCheck check)
        {
            _checks.Add(check);
        }

        public bool Process(Order order)
        {
            foreach (var check in _checks)
            {
                if (!check.Passes(order)) return false;
            }

            return true;
        }
    }

    public interface IGrantPipeline
    {
        Task<bool> ProcessAsync(GrantContext context);
    }

    public class GrantPipeline : IGrantPipeline
    {
        private readonly List<ICancelRule> _rules = new List<ICancelRule>();

        public void RegisterRule(ICancelRule rule)
        {
            _rules.Add(rule);
        }

        public async Task<bool> ProcessAsync(GrantContext context)
        {
            foreach (var rule in _rules)
            {
                await rule.CheckAsync(context);
                if (context.Granted)
                {
                    break;
                }
            }

            if (!context.Granted)
            {
                return false;
            }

            return true;
        }
    }

    public interface ILayerPipeline
    {
        Task<Order> ProcessAsync(Order order);
    }

    public class LayerPipeline : ILayerPipeline
    {
        private readonly List<ILayerStep> _steps = new List<ILayerStep>();

        public void RegisterStep(ILayerStep step)
        {
            _steps.Add(step);
        }

        public async Task<Order> ProcessAsync(Order order)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(order);
                if (!order.Valid) return null;
            }

            return order;
        }
    }
}
