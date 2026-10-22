using System;
using System.Threading.Tasks;
using Bakery.Api.Models;

namespace Bakery.Api.Steps
{
    public interface IOrderStep
    {
        Task ProcessAsync(Order order);
    }

    public class CheckFlourStep : IOrderStep
    {
        public Task ProcessAsync(Order order)
        {
            if (order.Flour < order.Loaves)
            {
                order.Valid = false;
            }

            return Task.CompletedTask;
        }
    }

    public class ReserveOvenStep : IOrderStep
    {
        private const int MaxLoaves = 40;

        public Task ProcessAsync(Order order)
        {
            if (order.Loaves > MaxLoaves) throw new OvenBusyException();
            return Task.CompletedTask;
        }
    }

    public class StampTicketStep : IOrderStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = Guid.NewGuid().ToString();
            return Task.CompletedTask;
        }
    }

    public interface IOrderCheck
    {
        bool Passes(Order order);
    }

    public class FlourCheck : IOrderCheck
    {
        public bool Passes(Order order)
        {
            if (order.Flour <= 0) return false;
            return true;
        }
    }

    public class SugarCheck : IOrderCheck
    {
        public bool Passes(Order order)
        {
            if (order.Sugar <= 0)
            {
                return false;
            }

            return true;
        }
    }

    public class ButterCheck : IOrderCheck
    {
        public bool Passes(Order order)
        {
            return true;
        }
    }

    public interface ICancelRule
    {
        Task CheckAsync(GrantContext context);
    }

    public class OwnerRule : ICancelRule
    {
        public Task CheckAsync(GrantContext context)
        {
            if (context.Caller == "owner")
            {
                context.Granted = true;
            }

            return Task.CompletedTask;
        }
    }

    public class ManagerRule : ICancelRule
    {
        public Task CheckAsync(GrantContext context)
        {
            if (context.Caller == "manager")
            {
                context.Granted = true;
            }

            return Task.CompletedTask;
        }
    }
}
